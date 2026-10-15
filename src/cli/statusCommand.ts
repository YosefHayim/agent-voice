/** `voxkey status [--json]`: the workers, the dictation stage, the hooks, and the main settings. */

import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { registeredAgents } from "../agents/hookRegistration.js";
import { readConfigOrDefaults } from "../settings/configFile.js";
import { configFilePath, voxkeyHome } from "../settings/voxkeyHome.js";
import { isWorkerRunning, readPid } from "../workers/workerProcesses.js";
import { readWorkerStatus } from "../workers/workerStatus.js";
import * as TerminalUI from "./TerminalUI.js";

const jsonOption = Options.boolean("json").pipe(Options.withDescription("Print one JSON document"));

const currentStatus = Effect.gen(function* () {
  const config = yield* readConfigOrDefaults;
  const dictationRunning = isWorkerRunning("dictation");
  const saved = readWorkerStatus();
  return {
    home: voxkeyHome(),
    configFile: configFilePath(),
    dictation: {
      running: dictationRunning,
      pid: Option.getOrUndefined(readPid("dictation.pid")),
      stage: dictationRunning
        ? Option.getOrElse(
            Option.map(saved, (status) => status.stage),
            () => "starting",
          )
        : "inactive",
      detail: Option.getOrElse(
        Option.map(saved, (status) => status.detail),
        () => "",
      ),
      model: Option.getOrElse(
        Option.map(saved, (status) => status.model),
        () => "",
      ),
      backend: Option.getOrElse(
        Option.map(saved, (status) => status.backend),
        () => "",
      ),
      language: config.dictationLanguage,
      hotkey: "hold-shift",
    },
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

export const statusCommand = Command.make("status", { json: jsonOption }, (args) =>
  Effect.gen(function* () {
    const status = yield* currentStatus;
    if (args.json) {
      yield* TerminalUI.json(status);
      return;
    }

    const dictation = status.dictation.running
      ? `on (pid ${String(status.dictation.pid)}) · ${status.dictation.stage}${status.dictation.detail === "" ? "" : ` · ${status.dictation.detail}`}`
      : "off";
    yield* TerminalUI.note(
      [
        `dictation   ${dictation}`,
        `model       ${status.dictation.model || "(not loaded)"} ${status.dictation.backend} · language ${status.dictation.language}`,
        `speech   ${status.speech.running ? "on" : "off"} · mode ${status.speech.mode} · voice ${status.speech.voice}${status.speech.muted ? " · muted" : ""}`,
        `refine      ${status.refine.mode}${status.refine.mode === "off" ? "" : ` · ${status.refine.provider}/${status.refine.model || "default"} → ${status.refine.sendTo}`}`,
        `hooks       ${status.hooks.length === 0 ? "none (run voxkey on)" : status.hooks.join(", ")}`,
        `config      ${status.configFile}`,
      ].join("\n"),
      "voxkey status",
    );
  }),
).pipe(Command.withDescription("Show the workers, the dictation stage, the agent hooks, and the main settings"));
