/**
 * Supertonic 3 text-to-speech in onnxruntime-node: duration predictor → text encoder → 8 flow-matching
 * steps of the vector estimator → vocoder, the same pipeline as the `supertonic` PyPI package.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { Effect, Schema } from "effect";
import type * as OnnxRuntime from "onnxruntime-node";

import type { Config } from "../settings/configSchema.js";
import { characterIds, supertonicText } from "./speechChunks.js";

export class SupertonicError extends Schema.TaggedError<SupertonicError>()("SupertonicError", {
  issue: Schema.String,
}) {
  get message(): string {
    return `Supertonic: ${this.issue}`;
  }
}

const ttsConfigSchema = Schema.parseJson(
  Schema.Struct({
    ae: Schema.Struct({ sample_rate: Schema.Number, base_chunk_size: Schema.Number }),
    ttl: Schema.Struct({ chunk_compress_factor: Schema.Number, latent_dim: Schema.Number }),
  }),
);

const indexerSchema = Schema.parseJson(Schema.Array(Schema.Number));

const styleTensorSchema = Schema.Struct({ dims: Schema.Array(Schema.Number), data: Schema.Unknown });

const voiceStyleSchema = Schema.parseJson(Schema.Struct({ style_ttl: styleTensorSchema, style_dp: styleTensorSchema }));

/** Quality steps; the old speech script used 8 too. */
const FLOW_STEPS = 8;

const fail = (issue: unknown) => new SupertonicError({ issue: issue instanceof Error ? issue.message : String(issue) });

const decodeFile = <Value>(schema: Schema.Schema<Value, string>, file: string) =>
  Effect.try({ try: () => Schema.decodeUnknownSync(schema)(readFileSync(file, "utf8")), catch: fail });

// Box–Muller: the flow starts from Gaussian noise, as numpy's randn does.
const gaussian = (): number => {
  const first = 1 - Math.random();
  const second = Math.random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

const flatNumbers = (nested: unknown): ReadonlyArray<number> =>
  Schema.decodeUnknownSync(Schema.Array(Schema.Number))([nested].flat(Number.POSITIVE_INFINITY));

/** Load the four ONNX sessions once; the returned engine renders one chunk of speech text at a time. */
export const loadSupertonic = (modelFolder: string) =>
  Effect.gen(function* () {
    const ort: typeof OnnxRuntime = yield* Effect.tryPromise({ try: () => import("onnxruntime-node"), catch: fail });
    const config = yield* decodeFile(ttsConfigSchema, path.join(modelFolder, "onnx", "tts.json"));
    const indexer = yield* decodeFile(indexerSchema, path.join(modelFolder, "onnx", "unicode_indexer.json"));
    const session = (name: string) =>
      Effect.tryPromise({
        try: () =>
          ort.InferenceSession.create(path.join(modelFolder, "onnx", `${name}.onnx`), { executionProviders: ["cpu"] }),
        catch: fail,
      });
    const durationPredictor = yield* session("duration_predictor");
    const textEncoder = yield* session("text_encoder");
    const vectorEstimator = yield* session("vector_estimator");
    const vocoder = yield* session("vocoder");
    const sampleRate = config.ae.sample_rate;
    const chunkSize = config.ae.base_chunk_size * config.ttl.chunk_compress_factor;
    const latentDimension = config.ttl.latent_dim * config.ttl.chunk_compress_factor;

    const styleTensors = (voice: Config["speechVoice"]) =>
      Effect.map(decodeFile(voiceStyleSchema, path.join(modelFolder, "voice_styles", `${voice}.json`)), (style) => ({
        textToLatent: new ort.Tensor("float32", Float32Array.from(flatNumbers(style.style_ttl.data)), [
          ...style.style_ttl.dims,
        ]),
        duration: new ort.Tensor("float32", Float32Array.from(flatNumbers(style.style_dp.data)), [
          ...style.style_dp.dims,
        ]),
      }));

    const firstOutput = (outputs: OnnxRuntime.InferenceSession.OnnxValueMapType, names: ReadonlyArray<string>) => {
      const tensor = outputs[names[0] || ""];
      return tensor === undefined ? Effect.fail(fail("a model returned no output")) : Effect.succeed(tensor);
    };

    const run = (request: {
      readonly model: OnnxRuntime.InferenceSession;
      readonly feeds: Readonly<Record<string, OnnxRuntime.Tensor>>;
    }) =>
      Effect.flatMap(
        Effect.tryPromise({ try: () => request.model.run({ ...request.feeds }), catch: fail }),
        (outputs) => firstOutput(outputs, request.model.outputNames),
      );

    /** Mono samples at `sampleRate` for one chunk of speech text. */
    const synthesize = (request: {
      readonly text: string;
      readonly voice: Config["speechVoice"];
      readonly speed: number;
    }) =>
      Effect.gen(function* () {
        const ids = characterIds(supertonicText(request.text), indexer);
        if (ids.length === 0) {
          return new Float32Array(0);
        }

        const style = yield* styleTensors(request.voice);
        const textIds = new ort.Tensor(
          "int64",
          BigInt64Array.from(ids, (id) => BigInt(id)),
          [1, ids.length],
        );
        const textMask = new ort.Tensor("float32", new Float32Array(ids.length).fill(1), [1, 1, ids.length]);
        const duration = yield* run({
          model: durationPredictor,
          feeds: { text_ids: textIds, style_dp: style.duration, text_mask: textMask },
        });
        const seconds = Number(duration.data[0] || 0) / request.speed;
        const textEmbedding = yield* run({
          model: textEncoder,
          feeds: { text_ids: textIds, style_ttl: style.textToLatent, text_mask: textMask },
        });
        const sampleCount = Math.max(Math.floor(seconds * sampleRate), 1);
        const latentLength = Math.max(Math.ceil(sampleCount / chunkSize), 1);
        const latentMask = new ort.Tensor("float32", new Float32Array(latentLength).fill(1), [1, 1, latentLength]);
        const totalSteps = new ort.Tensor("float32", Float32Array.from([FLOW_STEPS]), [1]);
        let latent: OnnxRuntime.Tensor = new ort.Tensor(
          "float32",
          Float32Array.from({ length: latentDimension * latentLength }, gaussian),
          [1, latentDimension, latentLength],
        );
        for (let step = 0; step < FLOW_STEPS; step += 1) {
          latent = yield* run({
            model: vectorEstimator,
            feeds: {
              noisy_latent: latent,
              text_emb: textEmbedding,
              style_ttl: style.textToLatent,
              text_mask: textMask,
              latent_mask: latentMask,
              current_step: new ort.Tensor("float32", Float32Array.from([step]), [1]),
              total_step: totalSteps,
            },
          });
        }
        const waveform = yield* run({ model: vocoder, feeds: { latent } });
        return Float32Array.from(waveform.data.slice(0, sampleCount), Number);
      });

    return { sampleRate, synthesize };
  });

export type SupertonicEngine = Effect.Effect.Success<ReturnType<typeof loadSupertonic>>;
