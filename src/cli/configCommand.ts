/** `voxkey config list | get | set | unset | pick-refine`: the settings in ~/.voxkey/config.json, applied at once. */

import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { selectWhisperModel } from "../dictation/whisperModels.js";
import { discoverProviders, REASONING_EFFORTS } from "../refine/providerModels.js";
import { saveRefineChoice } from "../refine/refineChoices.js";
import { pickerModels, pickRefineTargetWithDialogs, type RefinePick } from "../refine/refinePicker.js";
import { readConfig, saveConfig } from "../settings/configFile.js";
import {
  type Config,
  configSettings,
  defaultConfig,
  settingValueFromText,
  withSettingValue,
} from "../settings/configSchema.js";
import { readEnvironment } from "../settings/environmentVariables.js";
import { isWorkerRunning, startSpeechWorker, stopSpeech } from "../workers/workerProcesses.js";
import { CliUsageError } from "./cliUsageError.js";
import { describeSpeech, prepareModels, restartWorkers } from "./onCommand.js";
import * as TerminalUI from "./TerminalUI.js";

type ConfigSetting = (typeof configSettings)[number];

const findSetting = (name: string): Effect.Effect<ConfigSetting, CliUsageError> => {
  const setting = configSettings.find((candidate) => candidate.name === name || candidate.key === name);
  return setting === undefined
    ? Effect.fail(new CliUsageError({ issue: `Unknown setting "${name}". See \`voxkey config list\`.` }))
    : Effect.succeed(setting);
};

const shownValue = (config: Config, setting: ConfigSetting): string => {
  const value: unknown = config[setting.key];
  return value === undefined ? "(not set)" : JSON.stringify(value);
};

const nameArgument = Args.text({ name: "setting" }).pipe(Args.withDescription("Setting name, e.g. speech-mode"));

const listCommand = Command.make(
  "list",
  { json: Options.boolean("json").pipe(Options.withDescription("Print one JSON document")) },
  (args) =>
    Effect.gen(function* () {
      const config = yield* readConfig;
      if (args.json) {
        yield* TerminalUI.json(config);
        return;
      }

      yield* Effect.forEach(configSettings, (setting) => {
        const choices = setting.choices.length === 0 ? "" : ` (${setting.choices.join(" | ")})`;
        return TerminalUI.note(`${shownValue(config, setting)}${choices}\n${setting.description}`, setting.name);
      });
    }),
).pipe(Command.withDescription("Show every setting with its value and meaning"));

const getCommand = Command.make("get", { name: nameArgument }, (args) =>
  Effect.gen(function* () {
    const setting = yield* findSetting(args.name);
    yield* TerminalUI.text(shownValue(yield* readConfig, setting));
  }),
).pipe(Command.withDescription("Print one setting's value"));

/** Apply a saved change at once: a new language reloads Whisper, and speech starts or stops. */
const applyChange = (previous: Config, next: Config) =>
  Effect.gen(function* () {
    const environment = readEnvironment();
    const modelChanged =
      selectWhisperModel({ environment, config: previous }).key !==
      selectWhisperModel({ environment, config: next }).key;
    const dictationRunning = isWorkerRunning("dictation");
    if (modelChanged && dictationRunning) {
      yield* prepareModels(next);
      yield* restartWorkers;
      yield* TerminalUI.detail(`Dictation restarted with ${selectWhisperModel({ environment, config: next }).label}.`);
      return;
    }

    if (previous.speechMode === "off" && next.speechMode !== "off" && dictationRunning) {
      yield* prepareModels(next);
      startSpeechWorker();
      yield* TerminalUI.detail(`Speech started. ${describeSpeech(next)}`);
      return;
    }

    if (previous.speechMode !== "off" && next.speechMode === "off") {
      // The worker reads the mode only between replies, so a reply being read is stopped now.
      stopSpeech();
      yield* TerminalUI.detail("Speech stops within a second; dictation keeps running.");
      return;
    }

    if (!previous.speechMuted && next.speechMuted) {
      stopSpeech();
      yield* TerminalUI.detail("Speech muted; the reply being read stops now.");
      return;
    }

    yield* TerminalUI.detail("Applies from the next dictation or reply.");
  });

const saveSetting = (request: { readonly setting: ConfigSetting; readonly value: Option.Option<unknown> }) =>
  Effect.gen(function* () {
    const previous = yield* readConfig;
    const next = yield* withSettingValue({ config: previous, key: request.setting.key, value: request.value });
    yield* saveConfig(next);
    yield* TerminalUI.success(`${request.setting.name} = ${shownValue(next, request.setting)}`);
    yield* applyChange(previous, next);
  });

const setCommand = Command.make(
  "set",
  { name: nameArgument, value: Args.text({ name: "value" }).pipe(Args.withDescription("The new value")) },
  (args) =>
    Effect.gen(function* () {
      const setting = yield* findSetting(args.name);
      yield* saveSetting({ setting, value: yield* settingValueFromText({ setting, text: args.value }) });
    }),
).pipe(Command.withDescription("Change one setting, e.g. `voxkey config set dictation-language he`"));

const unsetCommand = Command.make("unset", { name: nameArgument }, (args) =>
  Effect.gen(function* () {
    const setting = yield* findSetting(args.name);
    const fallback: unknown = defaultConfig[setting.key];
    yield* saveSetting({ setting, value: fallback === undefined ? Option.none() : Option.some(fallback) });
  }),
).pipe(Command.withDescription("Put one setting back to its default"));

/** Provider, model, and effort from a terminal menu of the agent CLIs found on this Mac. */
const pickInTerminal = (config: Config) =>
  Effect.gen(function* () {
    const providers = yield* discoverProviders({ refresh: true });
    if (providers.length === 0) {
      return Option.none<RefinePick>();
    }

    const provider = yield* TerminalUI.selectOne({
      message: "Refine provider (found on this Mac)",
      choices: providers.map((found) => ({
        title: found.id,
        value: found,
        description: `${found.binary}, ${String(found.models.length)} models`,
      })),
      initial: providers.find((found) => found.id === config.refineProvider),
    });
    const model = yield* TerminalUI.selectOne({
      message: `Model for ${provider.id}`,
      choices: pickerModels({
        provider: provider.id,
        providers,
        preferred: { provider: config.refineProvider, model: config.refineModel || "" },
      }).map((name) => ({
        title: name,
        value: name,
      })),
    });
    const effort = provider.effort
      ? yield* TerminalUI.selectOne({
          message: "Reasoning effort",
          choices: REASONING_EFFORTS.map((name) => ({ title: name, value: name })),
          initial: config.refineEffort || "low",
        })
      : "";
    return Option.some({ provider: provider.id, model, effort });
  });

const pickRefineCommand = Command.make(
  "pick-refine",
  { gui: Options.boolean("gui").pipe(Options.withDescription("Use macOS dialogs instead of the terminal menu")) },
  (args) =>
    Effect.gen(function* () {
      const config = yield* readConfig;
      const useDialogs = args.gui || !(yield* TerminalUI.isInteractiveTerminal);
      const picked = useDialogs
        ? yield* pickRefineTargetWithDialogs({
            reason: "",
            preferredProvider: config.refineProvider,
            preferredModel: config.refineModel || "",
            preferredEffort: config.refineEffort || "",
            offerSkip: false,
          })
        : yield* pickInTerminal(config);
      if (Option.isNone(picked)) {
        return yield* new CliUsageError({ issue: "No refine provider picked (none found, or cancelled)." });
      }

      const effort = REASONING_EFFORTS.find((name) => name === picked.value.effort);
      const next = yield* withSettingValue({
        config: { ...config, refineProvider: picked.value.provider, refineModel: picked.value.model },
        key: "refineEffort",
        value: Option.fromNullable(effort),
      });
      yield* saveConfig(next);
      saveRefineChoice(picked.value);
      yield* TerminalUI.success(
        `refine → ${picked.value.provider}/${picked.value.model}${effort === undefined ? "" : ` effort ${effort}`}`,
      );
    }),
).pipe(Command.withDescription("Pick the refine provider, model, and effort from the agent CLIs on this Mac"));

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Show or change voxkey's settings"),
  Command.withSubcommands([listCommand, getCommand, setCommand, unsetCommand, pickRefineCommand]),
);
