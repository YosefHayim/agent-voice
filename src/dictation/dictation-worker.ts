// The dictation worker (`agent-voice worker dictation`): Whisper loads once, the mic stays open, the hold key is polled every
// 8 ms, the pill shows, and the speech worker starts. It runs until `agent-voice off` or `agent-voice reset`.

import { describeError } from "#src/error-message.js";
import { readSettingsOrDefaults } from "#src/settings/config-file.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { sleep } from "#src/sleep.js";
import { startPill, stopPill } from "#src/workers/pill.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import { claimWorkerLock, startSpeechWorker, stopRequested } from "#src/workers/worker-processes.js";
import { makeStatusWriter, type StatusWriter } from "#src/workers/worker-status.js";
import { startDictationQueue } from "./dictation-queue.js";
import { makeHoldController } from "./hold-controller.js";
import { HOLD_POLL_MS } from "./hold-key.js";
import { type Keyboard, loadKeyboard } from "./keyboard.js";
import { captionLoop, makeLiveCaption } from "./live-preview.js";
import { type ClipBuffer, type Microphone, makeClipBuffer, openMicrophone } from "./microphone.js";
import { loadTranscriber, readWhisperBackend, type Transcriber } from "./transcriber.js";
import { ensureWhisperModel, selectWhisperModel } from "./whisper-models.js";

const stopCheckMilliseconds = 100;

// Waits until `agent-voice off` or `agent-voice reset` asks the worker to stop.
const waitForStop = async (): Promise<void> => {
  const isStopRequested = stopRequested();
  if (isStopRequested) {
    return;
  }

  await sleep(stopCheckMilliseconds);
  return waitForStop();
};

// Warm-up runs in the background; a failure is logged, and the first decode loads the model anyway.
const warmTranscriber = async (transcriber: Transcriber): Promise<void> => {
  try {
    await transcriber.warmUp();
  } catch (error) {
    appendDictationLog(`warm-up failed: ${describeError(error)}`);
  }
};

// Runs until the worker is asked to stop or the microphone fails. The shutdown signal stops refine CLIs still running.
const runUntilStopped = async (request: {
  readonly transcriber: Transcriber;
  readonly clip: ClipBuffer;
  readonly keyboard: Keyboard;
  readonly microphone: Microphone;
  readonly status: StatusWriter;
  readonly isLivePreviewOn: boolean;
}): Promise<void> => {
  const { transcriber, clip, keyboard, microphone, status, isLivePreviewOn } = request;
  const shutdown = new AbortController();
  const caption = makeLiveCaption();
  const queue = startDictationQueue({ transcriber, keyboard, status, shutdown: shutdown.signal });
  const controller = makeHoldController({ keyboard, clip, caption, status, queue, shutdown: shutdown.signal });
  const pollTimer = setInterval(controller.poll, HOLD_POLL_MS);
  void warmTranscriber(transcriber);

  if (isLivePreviewOn) {
    void captionLoop({ clip, transcriber, caption, status, shutdown: shutdown.signal });
  }

  try {
    await Promise.race([waitForStop(), microphone.failure]);
  } finally {
    clearInterval(pollTimer);
    shutdown.abort();
  }
};

const runWithMicrophone = async (request: {
  readonly transcriber: Transcriber;
  readonly clip: ClipBuffer;
  readonly keyboard: Keyboard;
  readonly microphone: Microphone;
  readonly status: StatusWriter;
  readonly modelFile: string;
  readonly loadMs: string;
  readonly isSpeechOn: boolean;
  readonly isLivePreviewOn: boolean;
}): Promise<void> => {
  appendDictationLog(
    `worker pid=${String(process.pid)} model=${request.modelFile} load_ms=${request.loadMs} mic=${request.microphone.device}`,
  );
  request.status.write("inactive", `Ready (model load ${request.loadMs} ms, once)`);

  startPill(process.pid);
  try {
    if (request.isSpeechOn) {
      startSpeechWorker();
    }

    await runUntilStopped(request);
  } finally {
    stopPill();
  }
};

const runWithTranscriber = async (request: {
  readonly transcriber: Transcriber;
  readonly modelFile: string;
  readonly loadMs: string;
  readonly isSpeechOn: boolean;
  readonly isLivePreviewOn: boolean;
}): Promise<void> => {
  const clip = makeClipBuffer();
  const status = makeStatusWriter({
    model: request.transcriber.modelName,
    backend: readWhisperBackend(),
    recording: clip.isConfirmedHold,
  });
  const keyboard = await loadKeyboard();
  const microphone = await openMicrophone(clip);
  try {
    await runWithMicrophone({ ...request, clip, keyboard, microphone, status });
  } finally {
    microphone.close();
  }
};

const loadModelAndRun = async (): Promise<void> => {
  const settings = readSettingsOrDefaults();
  const environment = readEnvironment();
  const model = selectWhisperModel({ environment, config: settings });
  const loading = makeStatusWriter({ model: model.file, backend: readWhisperBackend(), recording: () => false });
  loading.write("starting", `Loading ${model.label}`);

  const modelPath = await ensureWhisperModel({
    model,
    onProgress: (bytes) => {
      const megabytes = Math.round(bytes / 1e6);
      loading.write("starting", `Downloading ${model.label}: ${String(megabytes)} MB`);
    },
  });
  const loadStarted = performance.now();
  const transcriber = await loadTranscriber(modelPath);
  const loadMs = (performance.now() - loadStarted).toFixed(0);
  try {
    await runWithTranscriber({
      transcriber,
      modelFile: model.file,
      loadMs,
      isSpeechOn: settings.speechMode !== "off",
      isLivePreviewOn: environment.AGENT_VOICE_DICTATION_LIVE_PREVIEW,
    });
  } finally {
    await transcriber.release();
  }
};

// A failure goes to status.json for `agent-voice on` and `agent-voice status`, and the next agent turn (or `agent-voice on`)
// starts a fresh worker.
export const runDictationWorker = async (): Promise<void> => {
  const releaseWorkerLock = claimWorkerLock("dictation");

  const isLockTaken = releaseWorkerLock == null;
  if (isLockTaken) {
    return;
  }

  try {
    await loadModelAndRun();
  } catch (error) {
    const detail = describeError(error);
    appendDictationLog(`worker failed: ${detail}`);
    const failed = makeStatusWriter({ model: "", backend: readWhisperBackend(), recording: () => false });
    failed.write("unavailable", detail);
    throw error;
  } finally {
    releaseWorkerLock();
  }
};
