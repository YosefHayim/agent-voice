import { registeredSettingsFiles } from "#src/agents/hook-registration.js";
import {
  isWhisperModelPresent,
  selectWhisperModel,
  whisperModelPath,
  whisperModels,
} from "#src/dictation/whisper-models.js";
import { agentVoiceHome, configFilePath } from "#src/settings/agent-voice-home.js";
import { readConfigOrDefaults } from "#src/settings/config-file.js";
import type { Config } from "#src/settings/config-schema.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { isWorkerRunning, readPid } from "#src/workers/worker-processes.js";
import { readWorkerStatus } from "#src/workers/worker-status.js";
import { type CommandSpec, isFlagOn } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const NOT_STARTED = { stage: "starting", detail: "", model: "", backend: "" };

const BYTES_PER_MEGABYTE = 1_000_000;

interface ModelEntry {
  readonly key: string;
  readonly label: string;
  readonly megabytes: number;
  readonly path: string;
  readonly present: boolean;
  readonly selected: boolean;
}

interface DictationStatus {
  readonly running: boolean;
  readonly pid: number | undefined;
  readonly stage: string;
  readonly detail: string;
  readonly model: string;
  readonly backend: string;
  readonly language: string;
  readonly modelKey: string;
  readonly models: ReadonlyArray<ModelEntry>;
  readonly hotkey: string;
}

interface SpeechStatus {
  readonly running: boolean;
  readonly mode: string;
  readonly voice: string;
  readonly muted: boolean;
}

interface RefineStatus {
  readonly mode: string;
  readonly provider: string;
  readonly model: string;
  readonly sendTo: string;
}

interface AgentVoiceStatus {
  readonly home: string;
  readonly configFile: string;
  readonly dictation: DictationStatus;
  readonly speech: SpeechStatus;
  readonly refine: RefineStatus;
  readonly hooks: ReadonlyArray<string>;
}

const modelEntries = (selectedKey: string): ReadonlyArray<ModelEntry> =>
  whisperModels.map((model) => ({
    key: model.key,
    label: model.label,
    megabytes: Math.round(model.approximateBytes / BYTES_PER_MEGABYTE),
    path: whisperModelPath(model),
    present: isWhisperModelPresent(model),
    selected: model.key === selectedKey,
  }));

const dictationStatus = (settings: Config): DictationStatus => {
  const selected = selectWhisperModel({ environment: readEnvironment(), config: settings });
  const isRunning = isWorkerRunning("dictation");
  const pid = readPid("dictation.pid") ?? undefined;
  const saved = readWorkerStatus() ?? NOT_STARTED;
  const dictation = {
    running: isRunning,
    pid,
    stage: saved.stage,
    detail: saved.detail,
    model: saved.model,
    backend: saved.backend,
    language: settings.dictationLanguage,
    modelKey: selected.key,
    models: modelEntries(selected.key),
    hotkey: `hold-${settings.dictationHoldKey}`,
  };

  const isNotRunning = !isRunning;
  if (isNotRunning) {
    return { ...dictation, stage: "inactive" };
  }

  return dictation;
};

// Several Claude Code accounts count as one agent.
const registeredAgents = (): ReadonlyArray<string> => {
  const agents = registeredSettingsFiles().map((settingsFile) => settingsFile.agent);
  const uniqueAgents = new Set(agents);
  return [...uniqueAgents];
};

const readCurrentStatus = (): AgentVoiceStatus => {
  const settings = readConfigOrDefaults();
  return {
    home: agentVoiceHome(),
    configFile: configFilePath(),
    dictation: dictationStatus(settings),
    speech: {
      running: isWorkerRunning("speech"),
      mode: settings.speechMode,
      voice: settings.speechVoice,
      muted: settings.speechMuted,
    },
    refine: {
      mode: settings.refineMode,
      provider: settings.refineProvider,
      model: settings.refineModel || "",
      sendTo: settings.refineSendTo,
    },
    hooks: registeredAgents(),
  };
};

const dictationLine = (dictation: DictationStatus): string => {
  const isDictationNotRunning = !dictation.running;
  if (isDictationNotRunning) {
    return "off";
  }

  const line = `on (pid ${String(dictation.pid)}) · ${dictation.stage}`;

  const isDictationDetailEmpty = dictation.detail === "";
  if (isDictationDetailEmpty) {
    return line;
  }

  return `${line} · ${dictation.detail}`;
};

const modelLine = (dictation: DictationStatus): string => {
  const model = dictation.model || "(not loaded)";
  return `${model} ${dictation.backend} · language ${dictation.language} · selected ${dictation.modelKey}`;
};

const speechLine = (speech: SpeechStatus): string => {
  const isSpeechOn = speech.running;
  const line = `${isSpeechOn ? "on" : "off"} · mode ${speech.mode} · voice ${speech.voice}`;

  if (speech.muted) {
    return `${line} · muted`;
  }

  return line;
};

const refineLine = (refine: RefineStatus): string => {
  const isRefineModeOff = refine.mode === "off";
  if (isRefineModeOff) {
    return "off";
  }

  const model = refine.model || "default";
  return `${refine.mode} · ${refine.provider}/${model} → ${refine.sendTo}`;
};

const hooksLine = (hooks: ReadonlyArray<string>): string => {
  const isHooksEmpty = hooks.length === 0;
  if (isHooksEmpty) {
    return "none (run agent-voice on)";
  }

  return hooks.join(", ");
};

const statusMessage = (status: AgentVoiceStatus): string =>
  [
    `dictation   ${dictationLine(status.dictation)}`,
    `model       ${modelLine(status.dictation)}`,
    `speech      ${speechLine(status.speech)}`,
    `refine      ${refineLine(status.refine)}`,
    `hooks       ${hooksLine(status.hooks)}`,
    `config      ${status.configFile}`,
  ].join("\n");

export const statusCommand: CommandSpec = {
  name: "status",
  description: "Show the workers, the dictation stage, the agent hooks, and the main settings",
  flags: {
    json: { kind: "boolean", description: "Print one JSON document" },
  },
  positionals: [],
  run: async (parsedCommand) => {
    const status = readCurrentStatus();

    const isDocumentWanted = isFlagOn(parsedCommand, "json");
    if (isDocumentWanted) {
      TerminalUI.printDocument(status);
      return 0;
    }

    TerminalUI.printNote("agent-voice status", statusMessage(status));
    return 0;
  },
};
