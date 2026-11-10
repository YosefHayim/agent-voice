import { listRegisteredSettingsFiles } from "#src/agents/hook-registration.js";
import {
  isWhisperModelDownloaded,
  readWhisperModelPath,
  selectWhisperModel,
  whisperModels,
} from "#src/dictation/whisper-models.js";
import { readAgentVoiceHome, readSettingsFilePath } from "#src/settings/agent-voice-home.js";
import { readSettingsOrDefaults } from "#src/settings/config-file.js";
import type { Settings } from "#src/settings/config-schema.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { isWorkerRunning, readPid } from "#src/workers/worker-processes.js";
import { readWorkerStatus } from "#src/workers/worker-status.js";
import { type CommandSpec, isFlagOn } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const OFF_MODE = "off";

const BYTES_PER_MEGABYTE = 1_000_000;

interface ModelLine {
  readonly key: string;
  readonly label: string;
  readonly megabytes: number;
  readonly path: string;
  readonly present: boolean;
  readonly selected: boolean;
}

interface DictationStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly stage: string;
  readonly detail: string;
  readonly model: string;
  readonly backend: string;
  readonly language: string;
  readonly modelKey: string;
  readonly models: ReadonlyArray<ModelLine>;
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

const listModelLines = (selectedKey: string): ReadonlyArray<ModelLine> =>
  whisperModels.map((model) => ({
    key: model.key,
    label: model.label,
    megabytes: Math.round(model.approximateBytes / BYTES_PER_MEGABYTE),
    path: readWhisperModelPath(model),
    present: isWhisperModelDownloaded(model),
    selected: model.key === selectedKey,
  }));

const readDictationStatus = (settings: Settings): DictationStatus => {
  const currentEnvironment = readEnvironment();
  const selected = selectWhisperModel({ environment: currentEnvironment, config: settings });
  const isRunning = isWorkerRunning("dictation");
  const pid = readPid("dictation.pid");
  const saved = readWorkerStatus() ?? { stage: "starting", detail: "", model: "", backend: "" };
  const dictation = {
    running: isRunning,
    pid,
    stage: saved.stage,
    detail: saved.detail,
    model: saved.model,
    backend: saved.backend,
    language: settings.dictationLanguage,
    modelKey: selected.key,
    models: listModelLines(selected.key),
    hotkey: `hold-${settings.dictationHoldKey}`,
  };

  const isNotRunning = !isRunning;
  if (isNotRunning) {
    return { ...dictation, stage: "inactive" };
  }

  return dictation;
};

// Several Claude Code accounts count as one agent.
const listRegisteredAgents = (): ReadonlyArray<string> => {
  const agents = listRegisteredSettingsFiles().map((settingsFile) => settingsFile.agent);
  const uniqueAgents = new Set(agents);
  return [...uniqueAgents];
};

const readCurrentStatus = (): AgentVoiceStatus => {
  const settings = readSettingsOrDefaults();
  return {
    home: readAgentVoiceHome(),
    configFile: readSettingsFilePath(),
    dictation: readDictationStatus(settings),
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
    hooks: listRegisteredAgents(),
  };
};

const readDictationLine = (dictation: DictationStatus): string => {
  const isDictationNotRunning = !dictation.running;
  if (isDictationNotRunning) {
    return OFF_MODE;
  }

  const line = `on (pid ${String(dictation.pid)}) · ${dictation.stage}`;

  const isDictationDetailEmpty = dictation.detail === "";
  if (isDictationDetailEmpty) {
    return line;
  }

  return `${line} · ${dictation.detail}`;
};

const readModelLine = (dictation: DictationStatus): string => {
  const model = dictation.model || "(not loaded)";
  return `${model} ${dictation.backend} · language ${dictation.language} · selected ${dictation.modelKey}`;
};

const readSpeechLine = (speech: SpeechStatus): string => {
  const isSpeechOn = speech.running;
  const line = `${isSpeechOn ? "on" : OFF_MODE} · mode ${speech.mode} · voice ${speech.voice}`;

  if (speech.muted) {
    return `${line} · muted`;
  }

  return line;
};

const readRefineLine = (refine: RefineStatus): string => {
  const isRefineModeOff = refine.mode === OFF_MODE;
  if (isRefineModeOff) {
    return OFF_MODE;
  }

  const model = refine.model || "default";
  return `${refine.mode} · ${refine.provider}/${model} → ${refine.sendTo}`;
};

const readHooksLine = (hooks: ReadonlyArray<string>): string => {
  const isHooksEmpty = hooks.length === 0;
  if (isHooksEmpty) {
    return "none (run agent-voice on)";
  }

  return hooks.join(", ");
};

const readStatusMessage = (status: AgentVoiceStatus): string =>
  [
    `dictation   ${readDictationLine(status.dictation)}`,
    `model       ${readModelLine(status.dictation)}`,
    `speech      ${readSpeechLine(status.speech)}`,
    `refine      ${readRefineLine(status.refine)}`,
    `hooks       ${readHooksLine(status.hooks)}`,
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

    const statusMessage = readStatusMessage(status);
    TerminalUI.printNote("agent-voice status", statusMessage);
    return 0;
  },
};
