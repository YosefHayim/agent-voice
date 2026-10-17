import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { registeredSettingsFiles } from "../agents/hookRegistration.js";
import {
  isWhisperModelPresent,
  selectWhisperModel,
  whisperModelPath,
  whisperModels,
} from "../dictation/whisperModels.js";
import { agentVoiceHome, configFilePath } from "../settings/agentVoiceHome.js";
import { readConfigOrDefaults } from "../settings/configFile.js";
import type { Config } from "../settings/configSchema.js";
import { readEnvironment } from "../settings/environmentVariables.js";
import { isWorkerRunning, readPid } from "../workers/workerProcesses.js";
import { readWorkerStatus } from "../workers/workerStatus.js";
import * as TerminalUI from "./TerminalUI.js";

const NOT_STARTED = { stage: "starting", detail: "", model: "", backend: "" };

const BYTES_PER_MEGABYTE = 1_000_000;

const modelEntries = (selectedKey: string) =>
  whisperModels.map((model) => ({
    key: model.key,
    label: model.label,
    megabytes: Math.round(model.approximateBytes / BYTES_PER_MEGABYTE),
    path: whisperModelPath(model),
    present: isWhisperModelPresent(model),
    selected: model.key === selectedKey,
  }));

const dictationStatus = (config: Config) => {
  const selected = selectWhisperModel({ environment: readEnvironment(), config });
  const isRunning = isWorkerRunning("dictation");
  const pid = readPid("dictation.pid");
  const savedStatus = readWorkerStatus();
  const saved = Option.getOrElse(savedStatus, () => NOT_STARTED);
  const dictation = {
    running: isRunning,
    pid: Option.getOrUndefined(pid),
    stage: saved.stage,
    detail: saved.detail,
    model: saved.model,
    backend: saved.backend,
    language: config.dictationLanguage,
    modelKey: selected.key,
    models: modelEntries(selected.key),
    hotkey: "hold-shift",
  };
  if (!isRunning) {
    return { ...dictation, stage: "inactive" };
  }

  return dictation;
};

// Several Claude Code accounts count as one agent.
const registeredAgents = (): ReadonlyArray<string> => {
  const agents = registeredSettingsFiles().map((settings) => settings.agent);
  const uniqueAgents = new Set(agents);
  return [...uniqueAgents];
};

const currentStatus = Effect.gen(function* () {
  const config = yield* readConfigOrDefaults;
  return {
    home: agentVoiceHome(),
    configFile: configFilePath(),
    dictation: dictationStatus(config),
    speech: {
      running: isWorkerRunning("speech"),
      mode: config.speechMode,
      voice: config.speechVoice,
      muted: config.speechMuted,
    },
    refine: {
      mode: config.refineMode,
      provider: config.refineProvider,
      model: config.refineModel || "",
      sendTo: config.refineSendTo,
    },
    hooks: registeredAgents(),
  };
});

type AgentVoiceStatus = Effect.Effect.Success<typeof currentStatus>;

const speechState = (speech: AgentVoiceStatus["speech"]): string => {
  if (speech.running) {
    return "on";
  }

  return "off";
};

const dictationLine = (dictation: AgentVoiceStatus["dictation"]): string => {
  if (!dictation.running) {
    return "off";
  }

  const line = `on (pid ${String(dictation.pid)}) · ${dictation.stage}`;
  if (dictation.detail === "") {
    return line;
  }

  return `${line} · ${dictation.detail}`;
};

const modelLine = (dictation: AgentVoiceStatus["dictation"]): string => {
  const model = dictation.model || "(not loaded)";
  return `${model} ${dictation.backend} · language ${dictation.language} · selected ${dictation.modelKey}`;
};

const speechLine = (speech: AgentVoiceStatus["speech"]): string => {
  const line = `${speechState(speech)} · mode ${speech.mode} · voice ${speech.voice}`;
  if (speech.muted) {
    return `${line} · muted`;
  }

  return line;
};

const refineLine = (refine: AgentVoiceStatus["refine"]): string => {
  if (refine.mode === "off") {
    return "off";
  }

  const model = refine.model || "default";
  return `${refine.mode} · ${refine.provider}/${model} → ${refine.sendTo}`;
};

const hooksLine = (hooks: ReadonlyArray<string>): string => {
  if (hooks.length === 0) {
    return "none (run agent-voice on)";
  }

  return hooks.join(", ");
};

const statusText = (status: AgentVoiceStatus): string =>
  [
    `dictation   ${dictationLine(status.dictation)}`,
    `model       ${modelLine(status.dictation)}`,
    `speech      ${speechLine(status.speech)}`,
    `refine      ${refineLine(status.refine)}`,
    `hooks       ${hooksLine(status.hooks)}`,
    `config      ${status.configFile}`,
  ].join("\n");

const jsonOption = Options.boolean("json").pipe(Options.withDescription("Print one JSON document"));

export const statusCommand = Command.make("status", { json: jsonOption }, (args) =>
  Effect.gen(function* () {
    const status = yield* currentStatus;
    if (args.json) {
      return yield* TerminalUI.json(status);
    }

    const text = statusText(status);
    yield* TerminalUI.note("agent-voice status", text);
  }),
).pipe(Command.withDescription("Show the workers, the dictation stage, the agent hooks, and the main settings"));
