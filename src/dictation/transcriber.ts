// whisper.cpp in-process through @fugood/whisper.node (Metal on Apple Silicon): the model loads once per worker,
// and one context serves the final decode and the live caption, one at a time.

import { availableParallelism } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";
import type { Config } from "../settings/configSchema.js";
import { pcmFromSamples, prepareForWhisper, rootMeanSquare, syntheticSpeech } from "./clipAudio.js";
import { tidyWhisperText } from "./transcriptText.js";
import type { TranscribeOptions, WhisperModule } from "./whisperNode.js";

export class TranscriberError extends Schema.TaggedError<TranscriberError>()("TranscriberError", {
  issue: Schema.String,
}) {
  get message(): string {
    return `Whisper: ${this.issue}`;
  }
}

const transcriberError = (error: unknown): TranscriberError => {
  if (error instanceof Error) {
    return new TranscriberError({ issue: error.message });
  }

  return new TranscriberError({ issue: String(error) });
};

export const transcriptionSchema = Schema.Struct({
  text: Schema.String,
  decodeMs: Schema.Number,
  inputLevel: Schema.Number.annotations({ description: "RMS of the capture before normalizing, for the log." }),
  ranWhisper: Schema.Boolean.annotations({ description: "False when the clip was silence and Whisper was skipped." }),
});

export type Transcription = Schema.Schema.Type<typeof transcriptionSchema>;

type CaptionRequest = { readonly samples: Float32Array; readonly language: Config["dictationLanguage"] };

type TranscribeRequest = CaptionRequest & { readonly prompt: string };

type DecodeRequest = TranscribeRequest & { readonly threads: number };

// whisper.node takes a plain ArrayBuffer of 16-bit mono samples at 16 kHz.
const pcmBuffer = (pcm: Int16Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(pcm.byteLength);
  new Int16Array(buffer).set(pcm);
  return buffer;
};

const whisperOptions = (request: DecodeRequest): TranscribeOptions => {
  const options = {
    language: request.language,
    temperature: 0,
    bestOf: 1,
    maxContext: 0,
    maxThreads: request.threads,
  };
  if (request.prompt === "") {
    return options;
  }

  return { ...options, prompt: request.prompt };
};

// A constant specifier, so TypeScript does not type-check the package's own sources.
export const WHISPER_PACKAGE = "@fugood/whisper.node";

const importWhisper = async (): Promise<WhisperModule> => {
  const loaded: unknown = await import(WHISPER_PACKAGE);
  // The package ships no declarations (external type); whisperNode.d.ts describes the part voxkey calls.
  return loaded as WhisperModule;
};

const threadCount = (): number => {
  const cores = availableParallelism();
  const atLeastTwo = Math.max(cores, 2);
  return Math.min(atLeastTwo, 8);
};

const THREADS = threadCount();
const CAPTION_THREADS = Math.min(THREADS, 4);

export const loadTranscriber = (modelPath: string) =>
  Effect.gen(function* () {
    const whisper = yield* Effect.tryPromise({ try: importWhisper, catch: transcriberError });
    yield* Effect.tryPromise({ try: () => whisper.toggleNativeLog(false), catch: transcriberError });
    const context = yield* Effect.tryPromise({
      try: () => whisper.initWhisper({ filePath: modelPath, useGpu: true, useFlashAttn: true }),
      catch: transcriberError,
    });
    const lane = yield* Effect.makeSemaphore(1);

    const decode = (request: DecodeRequest) =>
      Effect.gen(function* () {
        const started = performance.now();
        const inputLevel = rootMeanSquare(request.samples);
        const region = prepareForWhisper(request.samples);
        if (region === undefined) {
          return { text: "", decodeMs: performance.now() - started, inputLevel, ranWhisper: false };
        }

        const pcm = pcmFromSamples(region);
        const audio = pcmBuffer(pcm);
        const options = whisperOptions(request);
        const decoded = yield* Effect.tryPromise({
          try: () => context.transcribeData(audio, options).promise,
          catch: transcriberError,
        });
        return {
          text: tidyWhisperText(decoded.result, region.length),
          decodeMs: performance.now() - started,
          inputLevel,
          ranWhisper: true,
        };
      });

    // The final decode waits for a caption pass that is already running.
    const transcribe = (request: TranscribeRequest): Effect.Effect<Transcription, TranscriberError> =>
      decode({ ...request, threads: THREADS }).pipe(lane.withPermits(1));

    // A caption pass is skipped while a final decode holds the model.
    const caption = (request: CaptionRequest): Effect.Effect<Option.Option<string>, TranscriberError> =>
      decode({ ...request, prompt: "", threads: CAPTION_THREADS }).pipe(
        lane.withPermitsIfAvailable(1),
        Effect.map((heard) => Option.map(heard, (transcription) => transcription.text)),
      );

    // Compiles the Metal kernels now, so the first real dictation is not a cold start; speech-like audio passes the VAD.
    const warmSamples = syntheticSpeech(1);
    const warm = transcribe({ samples: warmSamples, language: "en", prompt: "" }).pipe(Effect.ignore);

    const release = Effect.promise(() => context.release());

    return { modelName: path.basename(modelPath), transcribe, caption, warm, release };
  });

export type Transcriber = Effect.Effect.Success<ReturnType<typeof loadTranscriber>>;

export const whisperBackend = (): string => {
  const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
  if (!isAppleSilicon) {
    return "whisper.cpp";
  }

  return "whisper.cpp+metal";
};
