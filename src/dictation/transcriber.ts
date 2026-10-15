/**
 * whisper.cpp in-process through @fugood/whisper.node (Metal on Apple Silicon): the model is loaded once
 * per worker, and one context serves the final decode and the live caption, one at a time.
 */

import { availableParallelism } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";
import type { Config } from "../settings/configSchema.js";
import {
  pcmFromSamples,
  prepareForWhisper,
  rootMeanSquare,
  syntheticSpeech,
  tidyWhisperText,
} from "./speechDetection.js";
import type { WhisperModule } from "./whisperNode.js";

export class TranscriberError extends Schema.TaggedError<TranscriberError>()("TranscriberError", {
  issue: Schema.String,
}) {
  get message(): string {
    return `Whisper: ${this.issue}`;
  }
}

const fail = (issue: unknown) =>
  new TranscriberError({ issue: issue instanceof Error ? issue.message : String(issue) });

export const transcriptionSchema = Schema.Struct({
  text: Schema.String,
  decodeMs: Schema.Number,
  inputLevel: Schema.Number.annotations({ description: "RMS of the capture before normalizing, for the log." }),
  ranWhisper: Schema.Boolean.annotations({ description: "False when the clip was silence and Whisper was skipped." }),
});

export type Transcription = Schema.Schema.Type<typeof transcriptionSchema>;

// whisper.node takes a plain ArrayBuffer of 16-bit mono samples at 16 kHz.
const pcmBuffer = (pcm: Int16Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(pcm.byteLength);
  new Int16Array(buffer).set(pcm);
  return buffer;
};

/** The package name, kept in a constant so TypeScript does not type-check the package's own sources. */
export const WHISPER_PACKAGE = "@fugood/whisper.node";

const importWhisper = async (): Promise<WhisperModule> => {
  const loaded: unknown = await import(WHISPER_PACKAGE);
  // The package ships no declarations (external type); whisperNode.d.ts describes the part voxkey calls.
  return loaded as WhisperModule;
};

const THREADS = Math.min(Math.max(availableParallelism(), 2), 8);

/** Load the model once; the transcriber decodes clips, and offers captions only while it is idle. */
export const loadTranscriber = (modelPath: string) =>
  Effect.gen(function* () {
    const whisper = yield* Effect.tryPromise({ try: importWhisper, catch: fail });
    yield* Effect.tryPromise({ try: () => whisper.toggleNativeLog(false), catch: fail });
    const context = yield* Effect.tryPromise({
      try: () => whisper.initWhisper({ filePath: modelPath, useGpu: true, useFlashAttn: true }),
      catch: fail,
    });
    const lane = yield* Effect.makeSemaphore(1);

    const decode = (request: {
      readonly samples: Float32Array;
      readonly language: Config["dictationLanguage"];
      readonly prompt: string;
      readonly threads: number;
    }) =>
      Effect.gen(function* () {
        const started = performance.now();
        const inputLevel = rootMeanSquare(request.samples);
        const region = prepareForWhisper(request.samples);
        if (region === undefined) {
          return { text: "", decodeMs: performance.now() - started, inputLevel, ranWhisper: false };
        }

        const pcm = pcmFromSamples(region);
        const decoded = yield* Effect.tryPromise({
          try: () =>
            context.transcribeData(pcmBuffer(pcm), {
              language: request.language,
              temperature: 0,
              bestOf: 1,
              maxContext: 0,
              maxThreads: request.threads,
              ...(request.prompt === "" ? {} : { prompt: request.prompt }),
            }).promise,
          catch: fail,
        });
        return {
          text: tidyWhisperText(decoded.result, region.length),
          decodeMs: performance.now() - started,
          inputLevel,
          ranWhisper: true,
        };
      });

    /** The final decode of a clip; waits for a caption pass that is already running. */
    const transcribe = (request: {
      readonly samples: Float32Array;
      readonly language: Config["dictationLanguage"];
      readonly prompt: string;
    }): Effect.Effect<Transcription, TranscriberError> => lane.withPermits(1)(decode({ ...request, threads: THREADS }));

    /** A cheap caption pass, or none when a final decode holds the model. */
    const caption = (request: {
      readonly samples: Float32Array;
      readonly language: Config["dictationLanguage"];
    }): Effect.Effect<Option.Option<string>, TranscriberError> =>
      Effect.map(
        lane.withPermitsIfAvailable(1)(decode({ ...request, prompt: "", threads: Math.min(THREADS, 4) })),
        Option.map((transcription) => transcription.text),
      );

    /** Compile the Metal kernels now, so the first real dictation is not a cold start; speech-like audio passes the VAD. */
    const warm = Effect.ignore(transcribe({ samples: syntheticSpeech(1), language: "en", prompt: "" }));

    const release = Effect.promise(() => context.release());

    return { modelName: path.basename(modelPath), transcribe, caption, warm, release };
  });

export type Transcriber = Effect.Effect.Success<ReturnType<typeof loadTranscriber>>;

/** whisper.cpp with Metal on Apple Silicon, CPU elsewhere. */
export const whisperBackend = (): string =>
  process.platform === "darwin" && process.arch === "arm64" ? "whisper.cpp+metal" : "whisper.cpp";
