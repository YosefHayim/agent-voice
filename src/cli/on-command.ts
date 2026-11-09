import { existsSync, statSync } from "node:fs";

import { type HookChange, registerReplyHooks } from "#src/agents/hook-registration.js";
import { holdKeyLabels } from "#src/dictation/hold-key.js";
import {
  ensureWhisperModel,
  isWhisperModelPresent,
  selectWhisperModel,
  whisperModelPath,
} from "#src/dictation/whisper-models.js";
import { describeError } from "#src/error-message.js";
import { readConfig } from "#src/settings/config-file.js";
import type { Config } from "#src/settings/config-schema.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { sleep } from "#src/sleep.js";
import { ensureSupertonicModels, missingSupertonicFiles } from "#src/speech/supertonic-models.js";
import { startWorkers, stopWorkers } from "#src/workers/worker-processes.js";
import { type CommandSpec, type ExitCode, isFlagOn } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const backupNote = (change: HookChange): string => {
  if (change.backup === undefined) {
    return "";
  }

  return `; backup ${change.backup}`;
};

const printHookChange = (change: HookChange): void => {
  const where = `${change.displayName}: ${change.file}`;
  switch (change.change) {
    case "added":
    case "removed":
      TerminalUI.printSuccess(`${where} (${change.change}${backupNote(change)})`);
      return;
    case "unchanged":
      TerminalUI.printDetail(`${where} (already registered)`);
      return;
    case "absent":
      TerminalUI.printDetail(`${where} (nothing to remove)`);
      return;
    case "not installed":
      TerminalUI.printDetail(`${change.displayName}: not installed, skipped`);
      return;
    case "failed":
      TerminalUI.printWarning(`${where}: ${change.issue || "could not edit"}; left unchanged`);
      return;
  }
};

export const printHookChanges = (changes: ReadonlyArray<HookChange>): void => {
  for (const change of changes) {
    printHookChange(change);
  }
};

const megabytes = (bytes: number): string => {
  const rounded = Math.round(bytes / 1e6);
  return `${String(rounded)} MB`;
};

interface ModelDownload {
  readonly label: string;
  readonly partialFile: string;
  readonly finished: Promise<unknown>;
}

const showDownloadProgress = (download: ModelDownload): void => {
  const isPartialFilePresent = existsSync(download.partialFile);
  if (!isPartialFilePresent) {
    return;
  }

  const arrivedBytes = statSync(download.partialFile).size;
  TerminalUI.printDetail(`${download.label}: ${megabytes(arrivedBytes)} so far`);
};

// Prints the bytes so far every few seconds until the download settles; a failed download rethrows here.
const waitForDownload = async (download: ModelDownload): Promise<void> => {
  const progressIntervalMilliseconds = 3_000;
  let isDownloadRunning = true;
  const settledDownload = download.finished.finally(() => {
    isDownloadRunning = false;
  });
  while (isDownloadRunning) {
    await Promise.race([settledDownload, sleep(progressIntervalMilliseconds)]);
    if (isDownloadRunning) {
      showDownloadProgress(download);
    }
  }

  await settledDownload;
};

export const prepareModels = async (settings: Config): Promise<void> => {
  const environment = readEnvironment();
  const model = selectWhisperModel({ environment, config: settings });
  const isModelMissing = !isWhisperModelPresent(model);
  if (isModelMissing) {
    TerminalUI.printStep(`Downloading ${model.label} (~${megabytes(model.approximateBytes)})`);
    const modelDownloading = ensureWhisperModel({ model, onProgress: () => undefined });
    await waitForDownload({
      label: model.label,
      partialFile: `${whisperModelPath(model)}.partial`,
      finished: modelDownloading,
    });
  }

  const isVoiceDownloadNeeded = settings.speechMode !== "off" && missingSupertonicFiles().length > 0;
  if (isVoiceDownloadNeeded) {
    TerminalUI.printStep("Downloading the Supertonic voices (~400 MB)");
    await ensureSupertonicModels(() => undefined);
  }
};

const refineTarget = (settings: Config): string => {
  const model = settings.refineModel || "default model";
  if (settings.refineEffort === undefined) {
    return `${settings.refineProvider}/${model}`;
  }

  return `${settings.refineProvider}/${model} effort ${settings.refineEffort}`;
};

const describeRefine = (settings: Config): string => {
  const target = refineTarget(settings);
  if (settings.refinePressEnter) {
    return `${target} → ${settings.refineSendTo} + Enter`;
  }

  return `${target} → ${settings.refineSendTo}`;
};

export const describeSpeech = (settings: Config): string => {
  if (settings.speechMode === "off") {
    return "Speech: off (turn on with `agent-voice config set speech-mode auto`).";
  }

  const speech = `Speech: ${settings.speechMode}, voice ${settings.speechVoice}`;
  if (settings.speechMuted) {
    return `${speech}, muted (unmute with \`agent-voice config set speech-muted false\`).`;
  }

  return `${speech}.`;
};

const printOnSummary = (settings: Config): void => {
  const isClipboardRefineOn = settings.refineMode === "clipboard" || settings.refineMode === "both";
  const isDictationRefineOn = settings.refineMode === "dictation" || settings.refineMode === "both";
  const holdLabel = holdKeyLabels[settings.dictationHoldKey];
  TerminalUI.printDetail(`Hold ${holdLabel} alone to dictate; release to finish.`);
  if (settings.dictationHoldKey === "shift") {
    TerminalUI.printDetail("Tap Shift to stop speech.");
  }

  TerminalUI.printDetail(describeSpeech(settings));
  if (isClipboardRefineOn && settings.dictationHoldKey === "shift") {
    TerminalUI.printDetail("Double-tap Shift to refine the copied prompt, then press ⌘V.");
  }

  if (isDictationRefineOn) {
    TerminalUI.printDetail(`Dictation refine: ${describeRefine(settings)}.`);
  }
};

// Stop whatever runs first, so the fresh workers load the current config and models.
export const restartWorkers = async (): Promise<void> => {
  TerminalUI.printStep("Starting the dictation and speech workers");
  await stopWorkers();
  await startWorkers();
};

// A restart that fails once is tried again after a short pause; the first failure is shown, not dropped.
const restartWorkersWithRetry = async (): Promise<void> => {
  try {
    await restartWorkers();
  } catch (firstError) {
    TerminalUI.printDetail(`Restart failed, trying once more: ${describeError(firstError)}`);
    const retryDelayMilliseconds = 1_000;
    await sleep(retryDelayMilliseconds);
    await restartWorkers();
  }
};

const printHooksOnlyOutro = (changes: ReadonlyArray<HookChange>): void => {
  const isRegistered = changes.some((change) => change.change === "added" || change.change === "unchanged");
  if (!isRegistered) {
    TerminalUI.printOutro("No agent hook was confirmed as registered (see above).");
    return;
  }

  TerminalUI.printOutro("Hooks registered. Run `agent-voice on` without --hooks-only to start dictation.");
};

export const onCommand: CommandSpec = {
  name: "on",
  description: "Register the agent Stop hooks, download missing models, and start dictation and speech",
  flags: {
    "hooks-only": {
      kind: "boolean",
      description: "Only register the agent Stop hooks: download nothing and start no worker",
    },
  },
  positionals: [],
  run: async (parsedCommand): Promise<ExitCode> => {
    TerminalUI.printIntro("on");
    TerminalUI.printStep("Registering `agent-voice reply` as the Stop hook of each installed agent");
    const changes = registerReplyHooks();
    printHookChanges(changes);

    const isHooksOnly = isFlagOn(parsedCommand, "hooks-only");
    if (isHooksOnly) {
      printHooksOnlyOutro(changes);
      return 0;
    }

    const settings = readConfig();
    await prepareModels(settings);
    await restartWorkersWithRetry();
    TerminalUI.printSuccess("agent-voice is on.");
    printOnSummary(settings);
    TerminalUI.printOutro("Check permissions any time with `agent-voice doctor`.");
    return 0;
  },
};
