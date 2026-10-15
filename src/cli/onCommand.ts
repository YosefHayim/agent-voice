/** `voxkey on`: register the agent Stop hooks, download missing models, and (re)start the workers. */

import { existsSync, statSync } from "node:fs";

import { Command, Options } from "@effect/cli";
import { Effect, Schedule } from "effect";

import { type HookChange, registerReplyHooks } from "../agents/hookRegistration.js";
import {
  ensureWhisperModel,
  isWhisperModelPresent,
  selectWhisperModel,
  whisperModelPath,
} from "../dictation/whisperModels.js";
import type { ModelDownloadError } from "../files/modelDownload.js";
import { readConfig } from "../settings/configFile.js";
import type { Config } from "../settings/configSchema.js";
import { readEnvironment } from "../settings/environmentVariables.js";
import { ensureSupertonicModels, missingSupertonicFiles } from "../speech/supertonicModels.js";
import { startWorkers, stopWorkers } from "../workers/workerProcesses.js";
import * as TerminalUI from "./TerminalUI.js";

export const HOLD_TO_DICTATE = "Hold Shift (alone) to dictate; release to finish. Tap Shift to stop speech.";

export const showHookChanges = (changes: ReadonlyArray<HookChange>) =>
  Effect.forEach(changes, (change) => {
    const where = `${change.displayName}: ${change.file}`;
    switch (change.change) {
      case "added":
      case "removed":
        return TerminalUI.success(
          `${where} (${change.change}${change.backup === undefined ? "" : `; backup ${change.backup}`})`,
        );
      case "unchanged":
        return TerminalUI.detail(`${where} (already registered)`);
      case "absent":
        return TerminalUI.detail(`${where} (nothing to remove)`);
      case "not installed":
        return TerminalUI.detail(`${change.displayName}: not installed, skipped`);
      case "failed":
        return TerminalUI.warn(`${where}: ${change.issue || "could not edit"}; left unchanged`);
    }
  });

const megabytes = (bytes: number) => `${String(Math.round(bytes / 1e6))} MB`;

/** Run a download while a progress line shows how much of the `.partial` file has arrived. */
export const downloadWithProgress = (request: {
  readonly label: string;
  readonly partialFile: () => string;
  readonly download: Effect.Effect<unknown, ModelDownloadError>;
}) =>
  Effect.raceFirst(
    request.download,
    Effect.zipRight(
      Effect.sleep("3 seconds"),
      Effect.forever(
        Effect.zipRight(
          Effect.suspend(() => {
            const partial = request.partialFile();
            return existsSync(partial)
              ? TerminalUI.detail(`${request.label}: ${megabytes(statSync(partial).size)} so far`)
              : Effect.void;
          }),
          Effect.sleep("3 seconds"),
        ),
      ),
    ),
  );

/** Whisper for the dictation language, plus Supertonic when speech is on. */
export const prepareModels = (config: Config) =>
  Effect.gen(function* () {
    const model = selectWhisperModel({ environment: readEnvironment(), config });
    if (!isWhisperModelPresent(model)) {
      yield* TerminalUI.step(`Downloading ${model.label} (~${megabytes(model.approximateBytes)})`);
      yield* downloadWithProgress({
        label: model.label,
        partialFile: () => `${whisperModelPath(model)}.partial`,
        download: ensureWhisperModel({ model, onProgress: () => undefined }),
      });
    }
    if (config.speechMode !== "off" && missingSupertonicFiles().length > 0) {
      yield* TerminalUI.step("Downloading the Supertonic voices (~400 MB)");
      yield* ensureSupertonicModels(() => undefined);
    }
  });

const describeRefine = (config: Config) => {
  const model = config.refineModel || "default model";
  const effort = config.refineEffort === undefined ? "" : ` effort ${config.refineEffort}`;
  const enter = config.refinePressEnter ? " + Enter" : "";
  return `${config.refineProvider}/${model}${effort} → ${config.refineSendTo}${enter}`;
};

export const describeSpeech = (config: Config) => {
  if (config.speechMode === "off") {
    return "Speech: off (turn on with `voxkey config set speech-mode auto`).";
  }

  const muted = config.speechMuted ? ", muted (unmute with `voxkey config set speech-muted false`)" : "";
  return `Speech: ${config.speechMode}, voice ${config.speechVoice}${muted}.`;
};

export const showOnSummary = (config: Config) =>
  Effect.gen(function* () {
    yield* TerminalUI.detail(HOLD_TO_DICTATE);
    yield* TerminalUI.detail(describeSpeech(config));
    if (config.refineMode === "clipboard" || config.refineMode === "both") {
      yield* TerminalUI.detail("Double-tap Shift to refine the copied prompt, then press ⌘V.");
    }
    if (config.refineMode === "dictation" || config.refineMode === "both") {
      yield* TerminalUI.detail(`Dictation refine: ${describeRefine(config)}.`);
    }
  });

/** Stop whatever runs, then start fresh so the workers load the current config and models. */
export const restartWorkers = Effect.gen(function* () {
  yield* TerminalUI.step("Starting the dictation and speech workers");
  yield* stopWorkers;
  yield* startWorkers;
});

const hooksOnlyOption = Options.boolean("hooks-only").pipe(
  Options.withDescription("Only register the agent Stop hooks: download nothing and start no worker"),
);

export const onCommand = Command.make("on", { hooksOnly: hooksOnlyOption }, (args) =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("on");
    yield* TerminalUI.step("Registering `voxkey reply` as the Stop hook of each installed agent");
    const changes = yield* registerReplyHooks;
    yield* showHookChanges(changes);
    if (args.hooksOnly) {
      const registered = changes.some((change) => change.change === "added" || change.change === "unchanged");
      yield* TerminalUI.outro(
        registered
          ? "Hooks registered. Run `voxkey on` without --hooks-only to start dictation."
          : "No agent hook was confirmed as registered (see above).",
      );
      return;
    }

    const config = yield* readConfig;
    yield* prepareModels(config);
    yield* restartWorkers.pipe(Effect.retry({ times: 1, schedule: Schedule.spaced("1 second") }));
    yield* TerminalUI.success("voxkey is on.");
    yield* showOnSummary(config);
    yield* TerminalUI.outro("Check permissions any time with `voxkey doctor`.");
  }),
).pipe(
  Command.withDescription("Register the agent Stop hooks, download missing models, and start dictation and speech"),
);
