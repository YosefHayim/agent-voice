// The dictation worker (`agent-voice worker dictation`): Whisper loads once, the mic stays open, the hold key is polled every
// 8 ms, the pill shows, and the speech worker starts. It runs until `agent-voice off` or `agent-voice reset`.

import { Effect, Schedule } from "effect";

import { readConfigOrDefaults } from "#src/settings/config-file.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { startPill, stopPill } from "#src/workers/pill.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import { claimWorkerLock, startSpeechWorker, stopRequested } from "#src/workers/worker-processes.js";
import { makeStatusWriter } from "#src/workers/worker-status.js";
import { startDictationQueue } from "./dictation-queue.js";
import { makeHoldController } from "./hold-controller.js";
import { HOLD_POLL_MS } from "./hold-key.js";
import { loadKeyboard } from "./keyboard.js";
import { captionLoop, makeLiveCaption } from "./live-preview.js";
import { makeClipBuffer, openMicrophone } from "./microphone.js";
import { loadTranscriber, whisperBackend } from "./transcriber.js";
import { ensureWhisperModel, selectWhisperModel } from "./whisper-models.js";

const waitForStop: Effect.Effect<void> = Effect.repeat(Effect.void, {
  schedule: Schedule.spaced("100 millis"),
  until: () => stopRequested(),
});

// The microphone rejects with an Error; anything else is wrapped so the failure text still reads.
const createErrorFromUnknown = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const runWorker = Effect.gen(function* () {
  const config = yield* Effect.sync(readConfigOrDefaults);
  const environment = readEnvironment();
  const model = selectWhisperModel({ environment, config });
  const loading = makeStatusWriter({ model: model.file, backend: whisperBackend(), recording: () => false });
  loading.write("starting", `Loading ${model.label}`);
  const modelPath = yield* Effect.tryPromise({
    try: () =>
      ensureWhisperModel({
        model,
        onProgress: (bytes) => {
          const megabytes = Math.round(bytes / 1e6);
          loading.write("starting", `Downloading ${model.label}: ${String(megabytes)} MB`);
        },
      }),
    catch: (error) => error,
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
  const microphone = yield* Effect.tryPromise({
    try: () => openMicrophone(clip),
    catch: (error) => error,
  }).pipe(Effect.acquireRelease((opened) => Effect.sync(() => opened.close())));
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
  if (environment.AGENT_VOICE_DICTATION_LIVE_PREVIEW) {
    yield* captionLoop({ clip, transcriber, caption, status }).pipe(Effect.forkScoped);
  }
  const controller = makeHoldController({ keyboard, clip, caption, status, queue });
  const pollEvery = Schedule.spaced(HOLD_POLL_MS);
  yield* controller.poll.pipe(Effect.repeat(pollEvery), Effect.forkScoped);
  const microphoneFailure = Effect.tryPromise({ try: () => microphone.failure, catch: createErrorFromUnknown });
  yield* Effect.raceFirst(waitForStop, microphoneFailure);
});

// A failure goes to status.json for `agent-voice on` and `agent-voice status`, and the next agent turn (or `agent-voice on`)
// starts a fresh worker.
export const runDictationWorker = Effect.gen(function* () {
  const claimedLockRelease = yield* Effect.sync(() => claimWorkerLock("dictation")).pipe(
    Effect.acquireRelease((release) => Effect.sync(() => release?.())),
  );
  const isLockTaken = claimedLockRelease === null;
  if (isLockTaken) {
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
