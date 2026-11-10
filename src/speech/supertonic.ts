import { readFileSync } from "node:fs";
import path from "node:path";

import type * as OnnxRuntime from "onnxruntime-node";
import { z } from "zod";

import { describeError } from "#src/error-message.js";
import type { Config } from "#src/settings/config-schema.js";
import { listCharacterIds, readSupertonicText } from "./speech-chunks.js";

export interface SynthesizeRequest {
  readonly text: string;
  readonly voice: Config["speechVoice"];
  readonly speed: number;
}

export interface SupertonicEngine {
  readonly sampleRate: number;
  readonly synthesize: (request: SynthesizeRequest) => Promise<Float32Array>;
}

const ttsConfigSchema = z.object({
  ae: z.object({ sample_rate: z.number(), base_chunk_size: z.number() }),
  ttl: z.object({ chunk_compress_factor: z.number(), latent_dim: z.number() }),
});

const numbersSchema = z.array(z.number());

const styleTensorSchema = z.object({ dims: numbersSchema, data: z.unknown() });

type StyleTensor = z.infer<typeof styleTensorSchema>;

const voiceStyleSchema = z.object({ style_ttl: styleTensorSchema, style_dp: styleTensorSchema });

// The same flow-matching step count as the `supertonic` PyPI package, so voices sound the same.
const FLOW_STEPS = 8;

const createSupertonicError = (issue: string, cause?: unknown): Error => new Error(`Supertonic: ${issue}`, { cause });

// Turns any failure from onnxruntime into one error that names Supertonic.
const wrapSupertonicErrors = async <Value>(work: () => Promise<Value>): Promise<Value> => {
  try {
    return await work();
  } catch (error) {
    throw createSupertonicError(describeError(error), error);
  }
};

const readSupertonicJson = <Output>(schema: z.ZodType<Output>, file: string): Output => {
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw createSupertonicError(describeError(error), error);
  }
};

// Box–Muller: the flow starts from Gaussian noise, as numpy's randn does.
const sampleGaussian = (): number => {
  const first = 1 - Math.random();
  const second = Math.random();
  const radius = Math.sqrt(-2 * Math.log(first));
  return radius * Math.cos(2 * Math.PI * second);
};

const listFlatNumbers = (nested: unknown): ReadonlyArray<number> => {
  const flat = [nested].flat(Number.POSITIVE_INFINITY);
  return numbersSchema.parse(flat);
};

const createOnes = (length: number): Float32Array => new Float32Array(length).fill(1);

const runModel = async (request: {
  readonly model: OnnxRuntime.InferenceSession;
  readonly feeds: Readonly<Record<string, OnnxRuntime.Tensor>>;
}) => {
  const outputs = await wrapSupertonicErrors(() => request.model.run({ ...request.feeds }));
  const firstName = request.model.outputNames[0] || "";
  const tensor = outputs[firstName];

  const isNoOutput = tensor === undefined;
  if (isNoOutput) {
    throw createSupertonicError("a model returned no output");
  }

  return tensor;
};

// onnxruntime-node is imported here, not at the top, so `agent-voice reply` never loads it.
export const loadSupertonic = async (modelFolder: string): Promise<SupertonicEngine> => {
  const ort: typeof OnnxRuntime = await wrapSupertonicErrors(() => import("onnxruntime-node"));
  const onnxFolder = path.join(modelFolder, "onnx");
  const configFile = path.join(onnxFolder, "tts.json");
  const indexerFile = path.join(onnxFolder, "unicode_indexer.json");
  const config = readSupertonicJson(ttsConfigSchema, configFile);
  const indexer = readSupertonicJson(numbersSchema, indexerFile);

  const loadSession = (name: string) =>
    wrapSupertonicErrors(() =>
      ort.InferenceSession.create(path.join(onnxFolder, `${name}.onnx`), { executionProviders: ["cpu"] }),
    );
  const durationPredictor = await loadSession("duration_predictor");
  const textEncoder = await loadSession("text_encoder");
  const vectorEstimator = await loadSession("vector_estimator");
  const vocoder = await loadSession("vocoder");

  const sampleRate = config.ae.sample_rate;
  const chunkSize = config.ae.base_chunk_size * config.ttl.chunk_compress_factor;
  const latentDimension = config.ttl.latent_dim * config.ttl.chunk_compress_factor;

  const readFloatTensor = (
    floats: Float32Array | ReadonlyArray<number>,
    dims: ReadonlyArray<number>,
  ): OnnxRuntime.Tensor => new ort.Tensor("float32", floats, dims);

  const readStyleTensor = (style: StyleTensor) => {
    const floats = listFlatNumbers(style.data);
    return readFloatTensor(floats, style.dims);
  };

  const readStyleTensors = (voice: Config["speechVoice"]) => {
    const styleFile = path.join(modelFolder, "voice_styles", `${voice}.json`);
    const style = readSupertonicJson(voiceStyleSchema, styleFile);
    return { textToLatent: readStyleTensor(style.style_ttl), duration: readStyleTensor(style.style_dp) };
  };

  // Mono samples at `sampleRate` for one chunk of speech text.
  const synthesize = async (request: SynthesizeRequest): Promise<Float32Array> => {
    const modelText = readSupertonicText(request.text);
    const ids = listCharacterIds(modelText, indexer);

    const isNoIds = ids.length === 0;
    if (isNoIds) {
      return new Float32Array(0);
    }

    const style = readStyleTensors(request.voice);
    const textIds = new ort.Tensor("int64", ids, [1, ids.length]);
    const textOnes = createOnes(ids.length);
    const textMask = readFloatTensor(textOnes, [1, 1, ids.length]);

    const duration = await runModel({
      model: durationPredictor,
      feeds: { text_ids: textIds, style_dp: style.duration, text_mask: textMask },
    });
    const textEmbedding = await runModel({
      model: textEncoder,
      feeds: { text_ids: textIds, style_ttl: style.textToLatent, text_mask: textMask },
    });

    const seconds = Number(duration.data[0] || 0) / request.speed;
    const wantedSamples = Math.floor(seconds * sampleRate);
    const sampleCount = Math.max(wantedSamples, 1);
    const latentLength = Math.ceil(sampleCount / chunkSize);
    const latentOnes = createOnes(latentLength);
    const latentMask = readFloatTensor(latentOnes, [1, 1, latentLength]);
    const totalSteps = readFloatTensor([FLOW_STEPS], [1]);

    const denoise = (noisyLatent: OnnxRuntime.Tensor, step: number) => {
      const currentStep = readFloatTensor([step], [1]);
      return runModel({
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

    const noiseSamples = Float32Array.from({ length: latentDimension * latentLength }, sampleGaussian);
    const noise = readFloatTensor(noiseSamples, [1, latentDimension, latentLength]);
    const steps = Array.from({ length: FLOW_STEPS }, (_unused, step) => step);
    let latent = noise;
    for (const step of steps) {
      latent = await denoise(latent, step);
    }

    const waveform = await runModel({ model: vocoder, feeds: { latent } });
    const samples = waveform.data.slice(0, sampleCount);
    return Float32Array.from(samples, Number);
  };

  return { sampleRate, synthesize };
};
