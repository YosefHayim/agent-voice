import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { selectWhisperModel } from "../dictation/whisperModels.js";
import { type DiscoveredProvider, discoverProviders, REASONING_EFFORTS } from "../refine/providerModels.js";
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

const findSetting = (name: string) =>
  Effect.gen(function* () {
    const setting = configSettings.find((candidate) => candidate.name === name || candidate.key === name);
    if (setting === undefined) {
      return yield* new CliUsageError({ issue: `Unknown setting "${name}". See \`agent-voice config list\`.` });
    }

    return setting;
  });

const shownValue = (config: Config, setting: ConfigSetting): string => {
  const value: unknown = config[setting.key];
  if (value === undefined) {
    return "(not set)";
  }

  return JSON.stringify(value);
};

const choicesNote = (setting: ConfigSetting): string => {
  if (setting.choices.length === 0) {
    return "";
  }

  return ` (${setting.choices.join(" | ")})`;
};

const showSetting = (config: Config, setting: ConfigSetting) => {
  const message = `${shownValue(config, setting)}${choicesNote(setting)}\n${setting.description}`;
  return TerminalUI.note(setting.name, message);
};

const nameArgument = Args.text({ name: "setting" }).pipe(Args.withDescription("Setting name, e.g. speech-mode"));

const jsonOption = Options.boolean("json").pipe(Options.withDescription("Print one JSON document"));

const listCommand = Command.make("list", { json: jsonOption }, (args) =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    if (args.json) {
      return yield* TerminalUI.json(config);
    }

    yield* Effect.forEach(configSettings, (setting) => showSetting(config, setting));
  }),
).pipe(Command.withDescription("Show every setting with its value and meaning"));

const getCommand = Command.make("get", { name: nameArgument }, (args) =>
  Effect.gen(function* () {
    const setting = yield* findSetting(args.name);
    const config = yield* readConfig;
    const value = shownValue(config, setting);
    yield* TerminalUI.text(value);
  }),
).pipe(Command.withDescription("Print one setting's value"));

const applyChange = (previous: Config, next: Config) =>
  Effect.gen(function* () {
    const environment = readEnvironment();
    const previousModel = selectWhisperModel({ environment, config: previous });
    const nextModel = selectWhisperModel({ environment, config: next });
    const isDictationRunning = isWorkerRunning("dictation");
    const isModelChanged = previousModel.key !== nextModel.key;
    const isSpeechTurnedOn = previous.speechMode === "off" && next.speechMode !== "off";
    const isSpeechTurnedOff = previous.speechMode !== "off" && next.speechMode === "off";
    const isNewlyMuted = !previous.speechMuted && next.speechMuted;
    if (isModelChanged && isDictationRunning) {
      yield* prepareModels(next);
      yield* restartWorkers;
      return yield* TerminalUI.detail(`Dictation restarted with ${nextModel.label}.`);
    }

    if (isSpeechTurnedOn && isDictationRunning) {
      yield* prepareModels(next);
      startSpeechWorker();
      return yield* TerminalUI.detail(`Speech started. ${describeSpeech(next)}`);
    }

    // The worker reads the mode only between replies, so a reply being read is stopped now.
    if (isSpeechTurnedOff) {
      stopSpeech();
      return yield* TerminalUI.detail("Speech stops within a second; dictation keeps running.");
    }

    if (isNewlyMuted) {
      stopSpeech();
      return yield* TerminalUI.detail("Speech muted; the reply being read stops now.");
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

const valueArgument = Args.text({ name: "value" }).pipe(Args.withDescription("The new value"));

const setCommand = Command.make("set", { name: nameArgument, value: valueArgument }, (args) =>
  Effect.gen(function* () {
    const setting = yield* findSetting(args.name);
    const value = yield* settingValueFromText({ setting, text: args.value });
    yield* saveSetting({ setting, value });
  }),
).pipe(Command.withDescription("Change one setting, e.g. `agent-voice config set dictation-language he`"));

const unsetCommand = Command.make("unset", { name: nameArgument }, (args) =>
  Effect.gen(function* () {
    const setting = yield* findSetting(args.name);
    const fallback: unknown = defaultConfig[setting.key];
    const value = Option.fromNullable(fallback);
    yield* saveSetting({ setting, value });
  }),
).pipe(Command.withDescription("Put one setting back to its default"));

const pickEffort = (provider: DiscoveredProvider, config: Config) =>
  Effect.gen(function* () {
    if (!provider.effort) {
      return "";
    }

    const choices = REASONING_EFFORTS.map((name) => ({ title: name, value: name }));
    return yield* TerminalUI.selectOne({ message: "Reasoning effort", choices, initial: config.refineEffort || "low" });
  });

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
    const models = pickerModels({
      provider: provider.id,
      providers,
      preferred: { provider: config.refineProvider, model: config.refineModel || "" },
    });
    const model = yield* TerminalUI.selectOne({
      message: `Model for ${provider.id}`,
      choices: models.map((name) => ({ title: name, value: name })),
    });
    const effort = yield* pickEffort(provider, config);
    return Option.some({ provider: provider.id, model, effort });
  });

const pickRefineTarget = (request: { readonly config: Config; readonly gui: boolean }) =>
  Effect.gen(function* () {
    const isInteractive = yield* TerminalUI.isInteractiveTerminal;
    const useDialogs = request.gui || !isInteractive;
    if (!useDialogs) {
      return yield* pickInTerminal(request.config);
    }

    return yield* pickRefineTargetWithDialogs({
      reason: "",
      preferredProvider: request.config.refineProvider,
      preferredModel: request.config.refineModel || "",
      preferredEffort: request.config.refineEffort || "",
      offerSkip: false,
    });
  });

const pickSummary = (pick: RefinePick, effort: string | undefined): string => {
  const target = `refine → ${pick.provider}/${pick.model}`;
  if (effort === undefined) {
    return target;
  }

  return `${target} effort ${effort}`;
};

const guiOption = Options.boolean("gui").pipe(
  Options.withDescription("Use macOS dialogs instead of the terminal menu"),
);

const pickRefineCommand = Command.make("pick-refine", { gui: guiOption }, (args) =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    const picked = yield* pickRefineTarget({ config, gui: args.gui });
    if (Option.isNone(picked)) {
      return yield* new CliUsageError({ issue: "No refine provider picked (none found, or cancelled)." });
    }

    const effort = REASONING_EFFORTS.find((name) => name === picked.value.effort);
    const pickedConfig = { ...config, refineProvider: picked.value.provider, refineModel: picked.value.model };
    const effortValue = Option.fromNullable(effort);
    const next = yield* withSettingValue({ config: pickedConfig, key: "refineEffort", value: effortValue });
    yield* saveConfig(next);
    saveRefineChoice(picked.value);
    const summary = pickSummary(picked.value, effort);
    yield* TerminalUI.success(summary);
  }),
).pipe(Command.withDescription("Pick the refine provider, model, and effort from the agent CLIs on this Mac"));

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Show or change agent-voice's settings"),
  Command.withSubcommands([listCommand, getCommand, setCommand, unsetCommand, pickRefineCommand]),
);
