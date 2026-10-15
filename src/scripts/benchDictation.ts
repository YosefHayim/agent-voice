/**
 * `pnpm bench [--models tiny,base,small,turbo-q5] [--seconds 1,2,4] [--runs 3]`: Whisper load and warm
 * decode times on synthetic speech (no mic, no typing). Downloads a missing model first.
 */

import { parseArgs } from "node:util";

import { Effect, Schema } from "effect";

import { SAMPLE_RATE, syntheticSpeech } from "../dictation/speechDetection.js";
import { loadTranscriber, whisperBackend } from "../dictation/transcriber.js";
import { ensureWhisperModel, whisperModels } from "../dictation/whisperModels.js";

const { values } = parseArgs({
  options: {
    models: { type: "string", default: "tiny,base,small,turbo-q5" },
    seconds: { type: "string", default: "1,2,4" },
    runs: { type: "string", default: "3" },
  },
});

const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

const round = (value: number) => Math.round(value * 10) / 10;

// A malformed --seconds or --runs stops the bench instead of timing an empty clip or no decodes at all.
const durationsSchema = Schema.Array(Schema.NumberFromString.pipe(Schema.finite(), Schema.positive()));

const runsSchema = Schema.NumberFromString.pipe(Schema.int(), Schema.positive());

const benchModel = (request: {
  readonly key: string;
  readonly seconds: ReadonlyArray<number>;
  readonly runs: number;
}) =>
  Effect.gen(function* () {
    const model = whisperModels.find((candidate) => candidate.key === request.key);
    if (model === undefined) {
      return { model: request.key, issue: "unknown model key" };
    }

    const modelPath = yield* ensureWhisperModel({ model, onProgress: () => undefined });
    const loadStarted = performance.now();
    const transcriber = yield* loadTranscriber(modelPath);
    const loadMs = performance.now() - loadStarted;
    const warmStarted = performance.now();
    yield* transcriber.warm;
    const warmMs = performance.now() - warmStarted;
    const clips = yield* Effect.forEach(request.seconds, (seconds) => {
      // syntheticSpeech pads very short requests, so the clip's own length is the audio that was decoded.
      const samples = syntheticSpeech(seconds);
      const audioSeconds = samples.length / SAMPLE_RATE;
      return Effect.map(
        Effect.forEach(Array.from({ length: request.runs }), () =>
          transcriber.transcribe({ samples, language: "en", prompt: "" }),
        ),
        (timings) => {
          const decodes = timings.map((timing) => timing.decodeMs);
          const mean = decodes.reduce((total, decode) => total + decode, 0) / decodes.length;
          return {
            audioSeconds,
            runs: request.runs,
            decodeMsMean: round(mean),
            decodeMsMin: round(Math.min(...decodes)),
            decodeMsMax: round(Math.max(...decodes)),
            realtimeFactor: round(audioSeconds / (mean / 1_000)),
          };
        },
      );
    });
    yield* transcriber.release;
    return { model: model.file, label: model.label, loadMs: round(loadMs), warmMs: round(warmMs), clips };
  });

const seconds = Schema.decodeUnknownSync(durationsSchema)(list(values.seconds));

const runs = Schema.decodeUnknownSync(runsSchema)(values.runs.trim());

const report = await Effect.runPromise(
  Effect.forEach(list(values.models), (key) => benchModel({ key, seconds, runs })),
);

process.stdout.write(
  `${JSON.stringify(
    {
      backend: whisperBackend(),
      note: "decodeMs is VAD + Whisper on synthetic speech-like audio with a warm model; loadMs is the one-time cold start.",
      models: report,
    },
    null,
    2,
  )}\n`,
);
