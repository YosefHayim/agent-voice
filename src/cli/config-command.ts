import { selectWhisperModel } from "#src/dictation/whisper-models.js";
import { type DiscoveredProvider, discoverProviders, REASONING_EFFORTS } from "#src/refine/provider-models.js";
import { saveRefineChoice } from "#src/refine/refine-choices.js";
import { listPickerModels, pickRefineTargetWithDialogs, type RefinePick } from "#src/refine/refine-picker.js";
import { readSettings, saveSettings } from "#src/settings/config-file.js";
import {
  defaultSettings,
  parseSettingField,
  type Settings,
  type SettingsField,
  setSettingField,
  settingDefinitions,
} from "#src/settings/config-schema.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { isWorkerRunning, startSpeechWorker, stopSpeech } from "#src/workers/worker-processes.js";
import { type CommandSpec, isFlagOn, readRequiredPositional } from "./command-spec.js";
import { describeSpeech, prepareModels, restartWorkers } from "./on-command.js";
import * as TerminalUI from "./terminal-ui.js";

type SettingDefinition = (typeof settingDefinitions)[number];

const findSetting = (settingName: string): SettingDefinition | null => {
  const setting = settingDefinitions.find(
    (candidate) => candidate.name === settingName || candidate.key === settingName,
  );
  return setting ?? null;
};

const describeUnknownSetting = (settingName: string): string =>
  `Unknown setting "${settingName}". See \`agent-voice config list\`.`;

const describeSettingField = (settings: Settings, setting: SettingDefinition): string => {
  const savedField: unknown = settings[setting.key];

  const isSavedMissing = savedField == null;
  if (isSavedMissing) {
    return "(not set)";
  }

  return JSON.stringify(savedField);
};

const describeChoices = (setting: SettingDefinition): string => {
  const isSettingChoicesEmpty = setting.choices.length === 0;
  if (isSettingChoicesEmpty) {
    return "";
  }

  return ` (${setting.choices.join(" | ")})`;
};

const printSetting = (settings: Settings, setting: SettingDefinition): void => {
  const message = `${describeSettingField(settings, setting)}${describeChoices(setting)}\n${setting.description}`;
  TerminalUI.printNote(setting.name, message);
};

const listCommand: CommandSpec = {
  name: "list",
  description: "Show every setting with its value and meaning",
  flags: {
    json: { kind: "boolean", description: "Print one JSON document" },
  },
  positionals: [],
  run: async (parsedCommand) => {
    const settings = readSettings();

    const isDocumentWanted = isFlagOn(parsedCommand, "json");
    if (isDocumentWanted) {
      TerminalUI.printDocument(settings);
      return 0;
    }

    for (const setting of settings) {
      printSetting(settings, setting);
    }

    return 0;
  },
};

// An unset optional setting has no value: null, so every entry carries the same fields.
const describeSettingLine = (settings: Settings, setting: SettingDefinition) => {
  const savedField: unknown = settings[setting.key];
  const { key: _key, ...described } = setting;

  const isSavedMissing = savedField == null;
  if (isSavedMissing) {
    return { ...described, value: null };
  }

  return { ...described, value: savedField };
};

const describeCommand: CommandSpec = {
  name: "describe",
  description: "Print every setting as JSON: name, label, description, kind, choices, and value",
  flags: {},
  positionals: [],
  run: async () => {
    const settings = readSettings();
    const describedSettings = settings.map((setting) => describeSettingLine(settings, setting));
    TerminalUI.printDocument(describedSettings);
    return 0;
  },
};

const getCommand: CommandSpec = {
  name: "get",
  description: "Print one setting's value",
  flags: {},
  positionals: [{ name: "setting", description: "Setting name, e.g. speech-mode", isRequired: true }],
  run: async (parsedCommand) => {
    const settingName = readRequiredPositional(parsedCommand, "setting");
    const setting = findSetting(settingName);

    const isSettingUnknown = setting == null;
    if (isSettingUnknown) {
      TerminalUI.printError(describeUnknownSetting(settingName));
      return 2;
    }

    const settings = readSettings();
    TerminalUI.printLine(describeSettingField(settings, setting));
    return 0;
  },
};

const applyChange = async (previous: Settings, next: Settings): Promise<void> => {
  const environment = readEnvironment();
  const previousModel = selectWhisperModel({ environment, config: previous });
  const nextModel = selectWhisperModel({ environment, config: next });
  const isDictationRunning = isWorkerRunning("dictation");
  const isModelChanged = previousModel.key !== nextModel.key;
  const isHoldKeyChanged = previous.dictationHoldKey !== next.dictationHoldKey;
  const isSpeechTurnedOn = previous.speechMode === "off" && next.speechMode !== "off";
  const isSpeechTurnedOff = previous.speechMode !== "off" && next.speechMode === "off";
  const isNewlyMuted = !previous.speechMuted && next.speechMuted;
  const isDictationRestartNeeded = (isModelChanged || isHoldKeyChanged) && isDictationRunning;
  const isSpeechStartNeeded = isSpeechTurnedOn && isDictationRunning;

  if (isDictationRestartNeeded) {
    await prepareModels(next);
    await restartWorkers();
    TerminalUI.printDetail(`Dictation restarted with ${nextModel.label}.`);
    return;
  }

  if (isSpeechStartNeeded) {
    await prepareModels(next);
    startSpeechWorker();
    TerminalUI.printDetail(`Speech started. ${describeSpeech(next)}`);
    return;
  }

  // The worker reads the mode only between replies, so a reply being read is stopped now.
  if (isSpeechTurnedOff) {
    stopSpeech();
    TerminalUI.printDetail("Speech stops within a second; dictation keeps running.");
    return;
  }

  if (isNewlyMuted) {
    stopSpeech();
    TerminalUI.printDetail("Speech muted; the reply being read stops now.");
    return;
  }

  TerminalUI.printDetail("Applies from the next dictation or reply.");
};

const saveSetting = async (request: {
  readonly setting: SettingDefinition;
  readonly answer: SettingsField | null;
}): Promise<void> => {
  const previous = readSettings();
  const next = setSettingField({ config: previous, key: request.setting.key, value: request.answer });
  saveSettings(next);
  TerminalUI.printSuccess(`${request.setting.name} = ${describeSettingField(next, request.setting)}`);
  await applyChange(previous, next);
};

const setCommand: CommandSpec = {
  name: "set",
  description: "Change one setting, e.g. `agent-voice config set dictation-language he`",
  flags: {},
  positionals: [
    { name: "setting", description: "Setting name, e.g. speech-mode", isRequired: true },
    { name: "value", description: "The new value", isRequired: true },
  ],
  run: async (parsedCommand) => {
    const settingName = readRequiredPositional(parsedCommand, "setting");
    const setting = findSetting(settingName);

    const isSettingUnknown = setting == null;
    if (isSettingUnknown) {
      TerminalUI.printError(describeUnknownSetting(settingName));
      return 2;
    }

    const enteredWords = readRequiredPositional(parsedCommand, "value");
    const answer = parseSettingField({ setting, enteredWords });
    await saveSetting({ setting, answer });
    return 0;
  },
};

const unsetCommand: CommandSpec = {
  name: "unset",
  description: "Put one setting back to its default",
  flags: {},
  positionals: [{ name: "setting", description: "Setting name, e.g. speech-mode", isRequired: true }],
  run: async (parsedCommand) => {
    const settingName = readRequiredPositional(parsedCommand, "setting");
    const setting = findSetting(settingName);

    const isSettingUnknown = setting == null;
    if (isSettingUnknown) {
      TerminalUI.printError(describeUnknownSetting(settingName));
      return 2;
    }

    const defaultAnswer = defaultSettings[setting.key] ?? null;
    await saveSetting({ setting, answer: defaultAnswer });
    return 0;
  },
};

// Null when the user cancels; an empty string when the provider has no effort setting.
const pickEffort = async (provider: DiscoveredProvider, settings: Settings): Promise<string | null> => {
  const isProviderEffortEmpty = !provider.effort;
  if (isProviderEffortEmpty) {
    return "";
  }

  return TerminalUI.askChoice({
    message: "Reasoning effort",
    choices: REASONING_EFFORTS.map((name) => ({ title: name, pick: name })),
    initial: settings.refineEffort || "low",
  });
};

const pickInTerminal = async (settings: Settings): Promise<RefinePick | null> => {
  const providers = await discoverProviders({ refresh: true });

  const hasNoProviders = providers.length === 0;
  if (hasNoProviders) {
    return null;
  }

  const provider = await TerminalUI.askChoice({
    message: "Refine provider (found on this Mac)",
    choices: providers.map((found) => ({
      title: found.id,
      pick: found,
      description: `${found.binary}, ${String(found.models.length)} models`,
    })),
    initial: providers.find((found) => found.id === settings.refineProvider),
  });

  const isProviderCancelled = provider == null;
  if (isProviderCancelled) {
    return null;
  }

  const models = listPickerModels({
    provider: provider.id,
    providers,
    preferred: { provider: settings.refineProvider, model: settings.refineModel || "" },
  });
  const model = await TerminalUI.askChoice({
    message: `Model for ${provider.id}`,
    choices: models.map((name) => ({ title: name, pick: name })),
  });

  const isModelCancelled = model == null;
  if (isModelCancelled) {
    return null;
  }

  const effort = await pickEffort(provider, settings);

  const isEffortCancelled = effort == null;
  if (isEffortCancelled) {
    return null;
  }

  return { provider: provider.id, model, effort };
};

const pickRefineTarget = async (request: {
  readonly settings: Settings;
  readonly isGuiWanted: boolean;
}): Promise<RefinePick | null> => {
  const isInteractive = TerminalUI.isInteractiveTerminal();

  const isNotDialogWanted = !request.isGuiWanted && isInteractive;
  if (isNotDialogWanted) {
    return pickInTerminal(request.settings);
  }

  return pickRefineTargetWithDialogs({
    reason: "",
    preferredProvider: request.settings.refineProvider,
    preferredModel: request.settings.refineModel || "",
    preferredEffort: request.settings.refineEffort || "",
    offerSkip: false,
  });
};

const describePickedTarget = (pick: RefinePick, effort: string | undefined): string => {
  const target = `refine → ${pick.provider}/${pick.model}`;

  const isEffortMissing = effort == null;
  if (isEffortMissing) {
    return target;
  }

  return `${target} effort ${effort}`;
};

const pickRefineCommand: CommandSpec = {
  name: "pick-refine",
  description: "Pick the refine provider, model, and effort from the agent CLIs on this Mac",
  flags: {
    gui: { kind: "boolean", description: "Use macOS dialogs instead of the terminal menu" },
  },
  positionals: [],
  run: async (parsedCommand) => {
    const settings = readSettings();
    const picked = await pickRefineTarget({ settings, isGuiWanted: isFlagOn(parsedCommand, "gui") });

    const isNothingPicked = picked == null;
    if (isNothingPicked) {
      TerminalUI.printError("No refine provider picked (none found, or cancelled).");
      return 2;
    }

    const effort = REASONING_EFFORTS.find((name) => name === picked.effort);
    const pickedSettings = { ...settings, refineProvider: picked.provider, refineModel: picked.model };
    const next = setSettingField({ config: pickedSettings, key: "refineEffort", value: effort ?? null });
    saveSettings(next);
    saveRefineChoice(picked);
    TerminalUI.printSuccess(describePickedTarget(picked, effort));
    return 0;
  },
};

export const settingsCommand: CommandSpec = {
  name: "config",
  description: "Show or change agent-voice's settings",
  flags: {},
  positionals: [],
  subcommands: [listCommand, describeCommand, getCommand, setCommand, unsetCommand, pickRefineCommand],
};
