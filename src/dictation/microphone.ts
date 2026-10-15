// The microphone stays open for the dictation worker's lifetime (PvRecorder, 16 kHz mono), so Shift only flips a
// recording flag and the first word is never clipped by device start-up.

import { Effect, Fiber, Schema } from "effect";

import { SAMPLE_RATE, samplesFromPcm } from "./clipAudio.js";

export class MicrophoneError extends Schema.TaggedError<MicrophoneError>()("MicrophoneError", {
  issue: Schema.String,
}) {
  get message(): string {
    return `Microphone: ${this.issue}`;
  }
}

const microphoneError = (error: unknown): MicrophoneError => {
  if (error instanceof Error) {
    return new MicrophoneError({ issue: error.message });
  }

  return new MicrophoneError({ issue: String(error) });
};

const FRAME_SAMPLES = 512;
// PvRecorder's own buffer: about 3 s of frames, so a busy event loop never drops audio.
const BUFFERED_FRAMES = 100;
const DEFAULT_DEVICE = -1;

const joined = (frames: ReadonlyArray<Int16Array>): Float32Array => {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const pcm = new Int16Array(length);
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.length;
  }
  return samplesFromPcm(pcm);
};

// Frames arriving while not recording are dropped. Shift down begins a clip that may still be a capital letter, and
// `confirm` marks it a hold. Every begin starts a new clip number, so work started for an earlier clip can tell it is late.
export const makeClipBuffer = () => {
  let frames: Array<Int16Array> = [];
  let recording = false;
  let confirmed = false;
  let clipNumber = 0;

  const begin = () => {
    frames = [];
    recording = true;
    confirmed = false;
    clipNumber += 1;
  };

  const append = (frame: Int16Array) => {
    if (recording) {
      frames.push(frame);
    }
  };

  const end = (): Float32Array => {
    recording = false;
    confirmed = false;
    const captured = joined(frames);
    frames = [];
    return captured;
  };

  const cancel = () => {
    recording = false;
    confirmed = false;
    frames = [];
  };

  // At least one frame, because slice(-0) would return the whole clip.
  const tail = (seconds: number): Float32Array => {
    const wanted = Math.ceil((seconds * SAMPLE_RATE) / FRAME_SAMPLES);
    const frameCount = Math.max(wanted, 1);
    const tailFrames = frames.slice(-frameCount);
    return joined(tailFrames);
  };

  return {
    begin,
    append,
    end,
    cancel,
    tail,
    confirm: () => {
      confirmed = recording;
    },
    isRecording: () => recording,
    isConfirmedHold: () => confirmed,
    clipNumber: () => clipNumber,
    sampleCount: () => frames.length * FRAME_SAMPLES,
  };
};

export type ClipBuffer = ReturnType<typeof makeClipBuffer>;

// `failure` fails when a read fails, so the worker ends (and is started fresh) instead of recording silence.
export const openMicrophone = (clip: ClipBuffer) =>
  Effect.gen(function* () {
    const { PvRecorder } = yield* Effect.tryPromise({
      try: () => import("@picovoice/pvrecorder-node"),
      catch: microphoneError,
    });
    const startRecorder = Effect.try({
      try: () => {
        const opened = new PvRecorder(FRAME_SAMPLES, DEFAULT_DEVICE, BUFFERED_FRAMES);
        opened.start();
        return opened;
      },
      catch: microphoneError,
    });
    const recorder = yield* Effect.acquireRelease(startRecorder, (opened) =>
      Effect.sync(() => {
        opened.stop();
        opened.release();
      }),
    );
    const readFrame = Effect.tryPromise({ try: () => recorder.read(), catch: microphoneError });
    const reader = yield* readFrame.pipe(
      Effect.flatMap((frame) => Effect.sync(() => clip.append(frame))),
      Effect.forever,
      Effect.forkScoped,
    );
    return { device: recorder.getSelectedDevice(), failure: Fiber.join(reader) };
  });
