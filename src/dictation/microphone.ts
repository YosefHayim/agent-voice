// The microphone stays open for the dictation worker's lifetime (PvRecorder, 16 kHz mono), so the hold key only flips a
// recording flag and the first word is never clipped by device start-up.

import type { PvRecorder } from "@picovoice/pvrecorder-node";

import { SAMPLE_RATE, samplesFromPcm } from "./clip-audio.js";

const createMicrophoneError = (error: unknown): Error => {
  const issue = error instanceof Error ? error.message : String(error);
  return new Error(`Microphone: ${issue}`, { cause: error });
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

// Frames arriving while not recording are dropped. A modifier press begins a clip that may still be a typing shortcut, and
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

export interface Microphone {
  readonly device: string;
  // Rejects when a read fails. Settles without error only after close().
  readonly failure: Promise<void>;
  readonly close: () => void;
}

const startRecorder = async (): Promise<PvRecorder> => {
  try {
    const recorderModule = await import("@picovoice/pvrecorder-node");
    const opened = new recorderModule.PvRecorder(FRAME_SAMPLES, DEFAULT_DEVICE, BUFFERED_FRAMES);
    opened.start();
    return opened;
  } catch (error) {
    throw createMicrophoneError(error);
  }
};

const readFramesUntilStopped = async (request: {
  readonly recorder: PvRecorder;
  readonly clip: ClipBuffer;
  readonly stop: AbortSignal;
}): Promise<void> => {
  while (!request.stop.aborted) {
    try {
      const frame = await request.recorder.read();
      request.clip.append(frame);
    } catch (error) {
      // A read that fails because close() stopped the recorder is expected, not a microphone failure.
      const isStopRequested = request.stop.aborted;
      if (isStopRequested) {
        return;
      }

      throw createMicrophoneError(error);
    }
  }
};

// `failure` rejects when a read fails, so the worker ends (and is started fresh) instead of recording silence.
export const openMicrophone = async (clip: ClipBuffer): Promise<Microphone> => {
  const recorder = await startRecorder();
  const readingStop = new AbortController();
  const failure = readFramesUntilStopped({ recorder, clip, stop: readingStop.signal });
  return {
    device: recorder.getSelectedDevice(),
    failure,
    close: () => {
      readingStop.abort();
      recorder.stop();
      recorder.release();
    },
  };
};
