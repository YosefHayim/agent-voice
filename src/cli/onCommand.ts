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

const HOLD_TO_DICTATE = "Hold Shift (alone) to dictate; release to finish. Tap Shift to stop speech.";

const backupNote = (change: HookChange): string => {
  if (change.backup === undefined) {
    return "";
  }

  return `; backup ${change.backup}`;
};

export const showHookChanges = (changes: ReadonlyArray<HookChange>) =>
  Effect.forEach(changes, (change) => {
    const where = `${change.displayName}: ${change.file}`;
    switch (change.change) {
      case "added":
      case "removed":
        return TerminalUI.success(`${where} (${change.change}${backupNote(change)})`);
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

const megabytes = (bytes: number): string => {
  const rounded = Math.round(bytes / 1e6);
  return `${String(rounded)} MB`;
};

type Download = {
  readonly label: string;
  readonly partialFile: () => string;
  readonly download: Effect.Effect<unknown, ModelDownloadError>;
};

const progressLine = (request: Download) =>
  Effect.gen(function* () {
    const partial = request.partialFile();
    if (!existsSync(partial)) {
      return;
    }

    const arrived = statSync(partial).size;
    yield* TerminalUI.detail(`${request.label}: ${megabytes(arrived)} so far`);
  });

const downloadWithProgress = (request: Download) => {
  const showProgress = progressLine(request);
  const progress = Effect.sleep("3 seconds").pipe(Effect.zipRight(showProgress), Effect.forever);
  return Effect.raceFirst(request.download, progress);
};

export const prepareModels = (config: Config) =>
  Effect.gen(function* () {
    const environment = readEnvironment();
    const model = selectWhisperModel({ environment, config });
    if (!isWhisperModelPresent(model)) {
      yield* TerminalUI.step(`Downloading ${model.label} (~${megabytes(model.approximateBytes)})`);
      yield* downloadWithProgress({
        label: model.label,
        partialFile: () => `${whisperModelPath(model)}.partial`,
        download: ensureWhisperModel({ model, onProgress: () => undefined }),
      });
    }

    const isVoiceDownloadNeeded = config.speechMode !== "off" && missingSupertonicFiles().length > 0;
    if (isVoiceDownloadNeeded) {
      yield* TerminalUI.step("Downloading the Supertonic voices (~400 MB)");
      yield* ensureSupertonicModels(() => undefined);
    }
  });

const refineTarget = (config: Config): string => {
  const model = config.refineModel || "default model";
  if (config.refineEffort === undefined) {
    return `${config.refineProvider}/${model}`;
  }

  return `${config.refineProvider}/${model} effort ${config.refineEffort}`;
};

const describeRefine = (config: Config): string => {
  const target = refineTarget(config);
  if (config.refinePressEnter) {
    return `${target} → ${config.refineSendTo} + Enter`;
  }

  return `${target} → ${config.refineSendTo}`;
};

export const describeSpeech = (config: Config): string => {
  if (config.speechMode === "off") {
    return "Speech: off (turn on with `agent-voice config set speech-mode auto`).";
  }

  const speech = `Speech: ${config.speechMode}, voice ${config.speechVoice}`;
  if (config.speechMuted) {
    return `${speech}, muted (unmute with \`agent-voice config set speech-muted false\`).`;
  }

  return `${speech}.`;
};

const showOnSummary = (config: Config) =>
  Effect.gen(function* () {
    const speech = describeSpeech(config);
    const isClipboardRefineOn = config.refineMode === "clipboard" || config.refineMode === "both";
    const isDictationRefineOn = config.refineMode === "dictation" || config.refineMode === "both";
    yield* TerminalUI.detail(HOLD_TO_DICTATE);
    yield* TerminalUI.detail(speech);
    if (isClipboardRefineOn) {
      yield* TerminalUI.detail("Double-tap Shift to refine the copied prompt, then press ⌘V.");
    }

    if (isDictationRefineOn) {
      yield* TerminalUI.detail(`Dictation refine: ${describeRefine(config)}.`);
    }
  });

// Stop whatever runs first, so the fresh workers load the current config and models.
export const restartWorkers = Effect.gen(function* () {
  yield* TerminalUI.step("Starting the dictation and speech workers");
  yield* stopWorkers;
  yield* startWorkers;
});

const hooksOnlyOption = Options.boolean("hooks-only").pipe(
  Options.withDescription("Only register the agent Stop hooks: download nothing and start no worker"),
);

const showHooksOnlyOutro = (changes: ReadonlyArray<HookChange>) => {
  const isRegistered = changes.some((change) => change.change === "added" || change.change === "unchanged");
  if (!isRegistered) {
    return TerminalUI.outro("No agent hook was confirmed as registered (see above).");
  }

  return TerminalUI.outro("Hooks registered. Run `agent-voice on` without --hooks-only to start dictation.");
};

export const onCommand = Command.make("on", { hooksOnly: hooksOnlyOption }, (args) =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("on");
    yield* TerminalUI.step("Registering `agent-voice reply` as the Stop hook of each installed agent");
    const changes = yield* registerReplyHooks;
    yield* showHookChanges(changes);
    if (args.hooksOnly) {
      return yield* showHooksOnlyOutro(changes);
    }

    const config = yield* readConfig;
    yield* prepareModels(config);
    yield* restartWorkers.pipe(Effect.retry({ times: 1, schedule: Schedule.spaced("1 second") }));
    yield* TerminalUI.success("agent-voice is on.");
    yield* showOnSummary(config);
    yield* TerminalUI.outro("Check permissions any time with `agent-voice doctor`.");
  }),
).pipe(
  Command.withDescription("Register the agent Stop hooks, download missing models, and start dictation and speech"),
);
