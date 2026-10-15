// The dictation worker (`voxkey worker dictation`): Whisper loads once, the mic stays open, Shift is polled every
// 8 ms, the pill shows, and the speech worker starts. It runs until `voxkey off` or `voxkey reset`.

import { Effect, Schedule } from "effect";

import { readConfigOrDefaults } from "../settings/configFile.js";
import { readEnvironment } from "../settings/environmentVariables.js";
import { startPill, stopPill } from "../workers/pill.js";
import { appendDictationLog } from "../workers/workerLog.js";
import { claimWorkerLock, startSpeechWorker, stopRequested } from "../workers/workerProcesses.js";
import { makeStatusWriter } from "../workers/workerStatus.js";
import { startDictationQueue } from "./dictationQueue.js";
import { makeHoldController } from "./holdController.js";
import { SHIFT_POLL_MS } from "./holdKey.js";
import { loadKeyboard } from "./keyboard.js";
import { captionLoop, makeLiveCaption } from "./livePreview.js";
import { makeClipBuffer, openMicrophone } from "./microphone.js";
import { loadTranscriber, whisperBackend } from "./transcriber.js";
import { ensureWhisperModel, selectWhisperModel } from "./whisperModels.js";

const waitForStop: Effect.Effect<void> = Effect.repeat(Effect.void, {
  schedule: Schedule.spaced("100 millis"),
  until: () => stopRequested(),
});

const runWorker = Effect.gen(function* () {
  const config = yield* readConfigOrDefaults;
  const environment = readEnvironment();
  const model = selectWhisperModel({ environment, config });
  const loading = makeStatusWriter({ model: model.file, backend: whisperBackend(), recording: () => false });
  loading.write("starting", `Loading ${model.label}`);
  const modelPath = yield* ensureWhisperModel({
    model,
    onProgress: (bytes) => {
      const megabytes = Math.round(bytes / 1e6);
      loading.write("starting", `Downloading ${model.label}: ${String(megabytes)} MB`);
    },
  });
  const loadStarted = performance.now();
  const transcriber = yield* loadTranscriber(modelPath).pipe(Effect.acquireRelease((loaded) => loaded.release));
  const loadMs = (performance.now() - loadStarted).toFixed(0);
  const clip = makeClipBuffer();
  const status = makeStatusWriter({
    model: transcriber.modelName,
    backend: whisperBackend(),
    recording: clip.isConfirmedHold,
  });
  const keyboard = yield* loadKeyboard;
  const microphone = yield* openMicrophone(clip);
  appendDictationLog(
    `worker pid=${String(process.pid)} model=${model.file} load_ms=${loadMs} mic=${microphone.device}`,
  );
  status.write("inactive", `Ready (model load ${loadMs} ms, once)`);

  yield* Effect.sync(() => startPill(process.pid)).pipe(Effect.acquireRelease(() => Effect.sync(stopPill)));
  if (config.speechMode !== "off") {
    startSpeechWorker();
  }
  yield* transcriber.warm.pipe(Effect.forkScoped);

  const caption = makeLiveCaption();
  const queue = yield* startDictationQueue({ transcriber, keyboard, status });
  if (environment.VOXKEY_DICTATION_LIVE_PREVIEW) {
    yield* captionLoop({ clip, transcriber, caption, status }).pipe(Effect.forkScoped);
  }
  const controller = makeHoldController({ keyboard, clip, caption, status, queue });
  const pollEvery = Schedule.spaced(SHIFT_POLL_MS);
  yield* controller.poll.pipe(Effect.repeat(pollEvery), Effect.forkScoped);
  yield* Effect.raceFirst(waitForStop, microphone.failure);
});

// A failure goes to status.json for `voxkey on` and `voxkey status`, and the next agent turn (or `voxkey on`)
// starts a fresh worker.
export const runDictationWorker = Effect.gen(function* () {
  const claimed = yield* claimWorkerLock("dictation");
  if (!claimed) {
    return;
  }

  // Its own inner scope: the mic and the pill are released before the outer scope lets go of the lock.
  yield* runWorker.pipe(
    Effect.scoped,
    Effect.tapError((failure) =>
      Effect.sync(() => {
        appendDictationLog(`worker failed: ${failure.message}`);
        const failed = makeStatusWriter({ model: "", backend: whisperBackend(), recording: () => false });
        failed.write("unavailable", failure.message);
      }),
    ),
  );
}).pipe(Effect.scoped);
