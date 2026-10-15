import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { registeredAgents } from "../agents/hookRegistration.js";
import { readConfigOrDefaults } from "../settings/configFile.js";
import type { Config } from "../settings/configSchema.js";
import { configFilePath, voxkeyHome } from "../settings/voxkeyHome.js";
import { isWorkerRunning, readPid } from "../workers/workerProcesses.js";
import { readWorkerStatus } from "../workers/workerStatus.js";
import * as TerminalUI from "./TerminalUI.js";

const NOT_STARTED = { stage: "starting", detail: "", model: "", backend: "" };

const dictationStatus = (config: Config) => {
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
    hotkey: "hold-shift",
  };
  if (!isRunning) {
    return { ...dictation, stage: "inactive" };
  }

  return dictation;
};

const currentStatus = Effect.gen(function* () {
  const config = yield* readConfigOrDefaults;
  return {
    home: voxkeyHome(),
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
    hooks: registeredAgents().map((target) => target.agent),
  };
});

type VoxkeyStatus = Effect.Effect.Success<typeof currentStatus>;

const speechState = (speech: VoxkeyStatus["speech"]): string => {
  if (speech.running) {
    return "on";
  }

  return "off";
};

const dictationLine = (dictation: VoxkeyStatus["dictation"]): string => {
  if (!dictation.running) {
    return "off";
  }

  const line = `on (pid ${String(dictation.pid)}) · ${dictation.stage}`;
  if (dictation.detail === "") {
    return line;
  }

  return `${line} · ${dictation.detail}`;
};

const modelLine = (dictation: VoxkeyStatus["dictation"]): string => {
  const model = dictation.model || "(not loaded)";
  return `${model} ${dictation.backend} · language ${dictation.language}`;
};

const speechLine = (speech: VoxkeyStatus["speech"]): string => {
  const line = `${speechState(speech)} · mode ${speech.mode} · voice ${speech.voice}`;
  if (speech.muted) {
    return `${line} · muted`;
  }

  return line;
};

const refineLine = (refine: VoxkeyStatus["refine"]): string => {
  if (refine.mode === "off") {
    return "off";
  }

  const model = refine.model || "default";
  return `${refine.mode} · ${refine.provider}/${model} → ${refine.sendTo}`;
};

const hooksLine = (hooks: ReadonlyArray<string>): string => {
  if (hooks.length === 0) {
    return "none (run voxkey on)";
  }

  return hooks.join(", ");
};

const statusText = (status: VoxkeyStatus): string =>
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
    yield* TerminalUI.note("voxkey status", text);
  }),
).pipe(Command.withDescription("Show the workers, the dictation stage, the agent hooks, and the main settings"));
