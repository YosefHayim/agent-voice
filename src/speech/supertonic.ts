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

const numbersSchema = Schema.Array(Schema.Number);

const indexerSchema = Schema.parseJson(numbersSchema);

const styleTensorSchema = Schema.Struct({ dims: numbersSchema, data: Schema.Unknown });

const voiceStyleSchema = Schema.parseJson(Schema.Struct({ style_ttl: styleTensorSchema, style_dp: styleTensorSchema }));

// The same flow-matching step count as the `supertonic` PyPI package, so voices sound the same.
const FLOW_STEPS = 8;

const fail = (issue: unknown) => {
  if (issue instanceof Error) {
    return new SupertonicError({ issue: issue.message });
  }

  return new SupertonicError({ issue: String(issue) });
};

const decodeFile = <Value>(schema: Schema.Schema<Value, string>, file: string) =>
  Effect.try({
    try: () => {
      const text = readFileSync(file, "utf8");
      return Schema.decodeUnknownSync(schema)(text);
    },
    catch: fail,
  });

// Box–Muller: the flow starts from Gaussian noise, as numpy's randn does.
const gaussian = (): number => {
  const first = 1 - Math.random();
  const second = Math.random();
  const radius = Math.sqrt(-2 * Math.log(first));
  return radius * Math.cos(2 * Math.PI * second);
};

const flatNumbers = (nested: unknown): ReadonlyArray<number> => {
  const flat = [nested].flat(Number.POSITIVE_INFINITY);
  return Schema.decodeUnknownSync(numbersSchema)(flat);
};

const ones = (length: number): Float32Array => new Float32Array(length).fill(1);

const run = (request: {
  readonly model: OnnxRuntime.InferenceSession;
  readonly feeds: Readonly<Record<string, OnnxRuntime.Tensor>>;
}) =>
  Effect.gen(function* () {
    const outputs = yield* Effect.tryPromise({ try: () => request.model.run({ ...request.feeds }), catch: fail });
    const firstName = request.model.outputNames[0] || "";
    const tensor = outputs[firstName];
    if (tensor === undefined) {
      return yield* fail("a model returned no output");
    }

    return tensor;
  });

// onnxruntime-node is imported here, not at the top, so `agent-voice reply` never loads it.
export const loadSupertonic = (modelFolder: string) =>
  Effect.gen(function* () {
    const ort: typeof OnnxRuntime = yield* Effect.tryPromise({ try: () => import("onnxruntime-node"), catch: fail });
    const onnxFolder = path.join(modelFolder, "onnx");
    const configFile = path.join(onnxFolder, "tts.json");
    const indexerFile = path.join(onnxFolder, "unicode_indexer.json");
    const config = yield* decodeFile(ttsConfigSchema, configFile);
    const indexer = yield* decodeFile(indexerSchema, indexerFile);
    const session = (name: string) => {
      const modelFile = path.join(onnxFolder, `${name}.onnx`);
      return Effect.tryPromise({
        try: () => ort.InferenceSession.create(modelFile, { executionProviders: ["cpu"] }),
        catch: fail,
      });
    };
    const durationPredictor = yield* session("duration_predictor");
    const textEncoder = yield* session("text_encoder");
    const vectorEstimator = yield* session("vector_estimator");
    const vocoder = yield* session("vocoder");
    const sampleRate = config.ae.sample_rate;
    const chunkSize = config.ae.base_chunk_size * config.ttl.chunk_compress_factor;
    const latentDimension = config.ttl.latent_dim * config.ttl.chunk_compress_factor;

    const floatTensor = (
      floats: Float32Array | ReadonlyArray<number>,
      dims: ReadonlyArray<number>,
    ): OnnxRuntime.Tensor => new ort.Tensor("float32", floats, dims);

    const styleTensor = (style: Schema.Schema.Type<typeof styleTensorSchema>) => {
      const floats = flatNumbers(style.data);
      return floatTensor(floats, style.dims);
    };

    const styleTensors = (voice: Config["speechVoice"]) => {
      const styleFile = path.join(modelFolder, "voice_styles", `${voice}.json`);
      return decodeFile(voiceStyleSchema, styleFile).pipe(
        Effect.map((style) => ({ textToLatent: styleTensor(style.style_ttl), duration: styleTensor(style.style_dp) })),
      );
    };

    // Mono samples at `sampleRate` for one chunk of speech text.
    const synthesize = (request: {
      readonly text: string;
      readonly voice: Config["speechVoice"];
      readonly speed: number;
    }) =>
      Effect.gen(function* () {
        const modelText = supertonicText(request.text);
        const ids = characterIds(modelText, indexer);
        if (ids.length === 0) {
          return new Float32Array(0);
        }

        const style = yield* styleTensors(request.voice);
        const textIds = new ort.Tensor("int64", ids, [1, ids.length]);
        const textOnes = ones(ids.length);
        const textMask = floatTensor(textOnes, [1, 1, ids.length]);
        const duration = yield* run({
          model: durationPredictor,
          feeds: { text_ids: textIds, style_dp: style.duration, text_mask: textMask },
        });
        const textEmbedding = yield* run({
          model: textEncoder,
          feeds: { text_ids: textIds, style_ttl: style.textToLatent, text_mask: textMask },
        });
        const seconds = Number(duration.data[0] || 0) / request.speed;
        const wantedSamples = Math.floor(seconds * sampleRate);
        const sampleCount = Math.max(wantedSamples, 1);
        const latentLength = Math.ceil(sampleCount / chunkSize);
        const latentOnes = ones(latentLength);
        const latentMask = floatTensor(latentOnes, [1, 1, latentLength]);
        const totalSteps = floatTensor([FLOW_STEPS], [1]);
        const denoise = (noisyLatent: OnnxRuntime.Tensor, step: number) => {
          const currentStep = floatTensor([step], [1]);
          return run({
            model: vectorEstimator,
            feeds: {
              noisy_latent: noisyLatent,
              text_emb: textEmbedding,
              style_ttl: style.textToLatent,
              text_mask: textMask,
              latent_mask: latentMask,
              current_step: currentStep,
              total_step: totalSteps,
            },
          });
        };
        const noiseSamples = Float32Array.from({ length: latentDimension * latentLength }, gaussian);
        const noise = floatTensor(noiseSamples, [1, latentDimension, latentLength]);
        const steps = Array.from({ length: FLOW_STEPS }, (_unused, step) => step);
        const latent = yield* Effect.reduce(steps, noise, denoise);
        const waveform = yield* run({ model: vocoder, feeds: { latent } });
        const samples = waveform.data.slice(0, sampleCount);
        return Float32Array.from(samples, Number);
      });

    return { sampleRate, synthesize };
  });

export type SupertonicEngine = Effect.Effect.Success<ReturnType<typeof loadSupertonic>>;
