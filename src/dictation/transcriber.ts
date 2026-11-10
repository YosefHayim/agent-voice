import { availableParallelism } from "node:os";
import path from "node:path";

import type { Settings } from "#src/settings/config-schema.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import { prepareForWhisper, readPcmFromSamples, readRootMeanSquare, readSyntheticSpeech } from "./clip-audio.js";
import { tidyWhisperTranscript } from "./transcript-text.js";
import type { TranscribeOptions, WhisperModule } from "./whisper-node.js";

interface Transcription {
  readonly text: string;
  readonly decodeMs: number;
  // RMS of the capture before normalizing, for the log.
  readonly inputLevel: number;
  readonly ranWhisper: boolean;
}

// whisper.cpp in-process through @fugood/whisper.node (Metal on Apple Silicon): the model loads once per worker,
// and one context serves the final decode and the live caption, one at a time.
export interface Transcriber {
  readonly modelName: string;
  readonly transcribe: (request: TranscribeRequest) => Promise<Transcription>;
  // Null when a final decode holds the model, so the caption pass is skipped.
  readonly readCaption: (request: CaptionRequest) => Promise<string | null>;
  readonly warmUp: () => Promise<void>;
  readonly release: () => Promise<void>;
}

type CaptionRequest = { readonly samples: Float32Array; readonly language: Settings["dictationLanguage"] };

type TranscribeRequest = CaptionRequest & { readonly prompt: string };

type DecodeRequest = TranscribeRequest & { readonly threads: number };

// whisper.node takes a plain ArrayBuffer of 16-bit mono samples at 16 kHz.
const readPcmBuffer = (pcm: Int16Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(pcm.byteLength);
  new Int16Array(buffer).set(pcm);
  return buffer;
};

const readWhisperSettings = (request: DecodeRequest): TranscribeOptions => {
  const settings = {
    language: request.language,
    temperature: 0,
    bestOf: 1,
    maxContext: 0,
    maxThreads: request.threads,
  };

  const isRequestPromptEmpty = request.prompt === "";
  if (isRequestPromptEmpty) {
    return settings;
  }

  return { ...settings, prompt: request.prompt };
};

// A constant specifier, so TypeScript does not type-check the package's own sources.
export const WHISPER_PACKAGE = "@fugood/whisper.node";

const importWhisper = async (): Promise<WhisperModule> => {
  const loaded: unknown = await import(WHISPER_PACKAGE);
  // The package ships no declarations (external type); whisper-node.d.ts describes the part agent-voice calls.
  return loaded as WhisperModule;
};

const readThreadCount = (): number => {
  const cores = availableParallelism();
  const minimumThreadCount = 2;

  const atLeastTwo = Math.max(cores, minimumThreadCount);
  const maximumThreadCount = 8;

  return Math.min(atLeastTwo, maximumThreadCount);
};

const THREADS = readThreadCount();
const CAPTION_THREADS = Math.min(THREADS, 4);

// Failures keep the Whisper prefix, so a log line says which engine failed.
const wrapWhisperErrors = async <Report>(task: () => Promise<Report>): Promise<Report> => {
  try {
    const taskReport = await task();
    return taskReport;
  } catch (error) {
    const isErrorInstanceError = error instanceof Error;
    const issue = isErrorInstanceError ? error.message : String(error);
    throw new Error(`Whisper: ${issue}`, { cause: error });
  }
};

interface DecodeLane {
  readonly run: <Result>(task: () => Promise<Result>) => Promise<Result>;
  readonly runIfFree: <Result>(task: () => Promise<Result>) => Promise<Result | null>;
}

// One decode at a time: a final decode waits its turn, a caption pass starts only when the model is free.
const createDecodeLane = (): DecodeLane => {
  const waitingTurns: Array<() => void> = [];
  let isBusy = false;

  const takeTurn = async (): Promise<void> => {
    const isNotBusy = !isBusy;
    if (isNotBusy) {
      isBusy = true;
      return;
    }

    await new Promise<void>((wake) => {
      waitingTurns.push(wake);
    });
  };

  const passTurn = (): void => {
    const nextTurn = waitingTurns.shift();

    const isNobodyWaiting = nextTurn == null;
    if (isNobodyWaiting) {
      isBusy = false;
      return;
    }

    // The model stays busy: the turn goes straight to the next waiting decode.
    nextTurn();
  };

  const run = async <Result>(task: () => Promise<Result>): Promise<Result> => {
    await takeTurn();

    try {
      const taskReport = await task();
      return taskReport;
    } finally {
      passTurn();
    }
  };

  const runIfFree = async <Result>(task: () => Promise<Result>): Promise<Result | null> => {
    if (isBusy) {
      return null;
    }

    isBusy = true;
    try {
      const taskReport = await task();
      return taskReport;
    } finally {
      passTurn();
    }
  };

  return { run, runIfFree };
};

export const loadTranscriber = async (modelPath: string): Promise<Transcriber> => {
  const whisper = await wrapWhisperErrors(importWhisper);
  await wrapWhisperErrors(() => whisper.toggleNativeLog(false));
  const whisperHandle = await wrapWhisperErrors(() =>
    whisper.initWhisper({ filePath: modelPath, useGpu: true, useFlashAttn: true }),
  );
  const lane = createDecodeLane();

  const decode = async (request: DecodeRequest): Promise<Transcription> => {
    const started = performance.now();
    const inputLevel = readRootMeanSquare(request.samples);
    const region = prepareForWhisper(request.samples);

    const isSilence = region == null;
    if (isSilence) {
      return { text: "", decodeMs: performance.now() - started, inputLevel, ranWhisper: false };
    }

    const pcm = readPcmFromSamples(region);
    const audio = readPcmBuffer(pcm);
    const transcribeOptions = readWhisperSettings(request);
    const decoded = await wrapWhisperErrors(() => whisperHandle.transcribeData(audio, transcribeOptions).promise);

    return {
      text: tidyWhisperTranscript(decoded.result, region.length),
      decodeMs: performance.now() - started,
      inputLevel,
      ranWhisper: true,
    };
  };

  // The final decode waits for a caption pass that is already running.
  const transcribe = (request: TranscribeRequest): Promise<Transcription> =>
    lane.run(() => decode({ ...request, threads: THREADS }));

  // A caption pass is skipped while a final decode holds the model.
  const readCaption = async (request: CaptionRequest): Promise<string | null> => {
    const heard = await lane.runIfFree(() => decode({ ...request, prompt: "", threads: CAPTION_THREADS }));

    const isModelBusy = heard == null;
    if (isModelBusy) {
      return null;
    }

    return heard.text;
  };

  // Compiles the Metal kernels now, so the first real dictation is not a cold start; speech-like audio passes the VAD.
  const warmUp = async (): Promise<void> => {
    const warmSamples = readSyntheticSpeech(1);

    try {
      await transcribe({ samples: warmSamples, language: "en", prompt: "" });
    } catch (error) {
      appendDictationLog(`whisper warm-up failed: ${String(error)}`);
    }
  };

  const release = (): Promise<void> => whisperHandle.release();

  return { modelName: path.basename(modelPath), transcribe, readCaption: readCaption, warmUp, release };
};

export const readWhisperBackend = (): string => {
  const isNotAppleSilicon = process.platform !== "darwin" || process.arch !== "arm64";
  if (isNotAppleSilicon) {
    return "whisper.cpp";
  }

  return "whisper.cpp+metal";
};
