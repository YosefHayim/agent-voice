// `pnpm test:bench [--models tiny,base,small,turbo-q5] [--seconds 1,2,4] [--runs 3]`: Whisper load and warm decode times
// on synthetic speech (no mic, no typing). Downloads a missing model first.

import { parseArgs } from "node:util";

import { z } from "zod";

import { readSyntheticSpeech, SAMPLE_RATE } from "#src/dictation/clip-audio.js";
import { loadTranscriber, readWhisperBackend, type Transcriber } from "#src/dictation/transcriber.js";
import { ensureWhisperModel, whisperModels } from "#src/dictation/whisper-models.js";

const { values: fields } = parseArgs({
  options: {
    models: { type: "string", default: "tiny,base,small,turbo-q5" },
    seconds: { type: "string", default: "1,2,4" },
    runs: { type: "string", default: "3" },
  },
});

const listCommaSeparatedList = (commaSeparatedNames: string) =>
  commaSeparatedNames
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");

const roundToTenth = (amount: number) => Math.round(amount * 10) / 10;

// A malformed --seconds or --runs stops the bench instead of timing an empty clip or no decodes at all.
const durationsSchema = z.array(z.coerce.number().positive());

const runsSchema = z.coerce.number().int().positive();

const millisecondsPerSecond = 1_000;

const readBenchClip = async (request: {
  readonly transcriber: Transcriber;
  readonly seconds: number;
  readonly runs: number;
}) => {
  // syntheticSpeech pads very short requests, so the clip's own length is the audio that was decoded.
  const samples = readSyntheticSpeech(request.seconds);
  const audioSeconds = samples.length / SAMPLE_RATE;

  const attempts = Array.from({ length: request.runs });
  const decodes: Array<number> = [];
  for (const _attempt of attempts) {
    const timing = await request.transcriber.transcribe({ samples, language: "en", prompt: "" });
    decodes.push(timing.decodeMs);
  }

  const mean = decodes.reduce((total, decode) => total + decode, 0) / decodes.length;
  const fastest = Math.min(...decodes);
  const slowest = Math.max(...decodes);
  return {
    audioSeconds,
    runs: request.runs,
    decodeMsMean: roundToTenth(mean),
    decodeMsMin: roundToTenth(fastest),
    decodeMsMax: roundToTenth(slowest),
    realtimeFactor: roundToTenth(audioSeconds / (mean / millisecondsPerSecond)),
  };
};

const readBenchModel = async (request: {
  readonly key: string;
  readonly seconds: ReadonlyArray<number>;
  readonly runs: number;
}) => {
  const model = whisperModels.find((candidate) => candidate.key === request.key);

  const isUnknownModel = model === undefined;
  if (isUnknownModel) {
    return { model: request.key, issue: "unknown model key" };
  }

  const modelPath = await ensureWhisperModel({ model, onProgress: () => undefined });

  const loadStarted = performance.now();
  const transcriber = await loadTranscriber(modelPath);
  const loadMs = performance.now() - loadStarted;

  const warmStarted = performance.now();
  await transcriber.warmUp();
  const warmMs = performance.now() - warmStarted;

  const clips = [];
  for (const seconds of request.seconds) {
    const clip = await readBenchClip({ transcriber, seconds, runs: request.runs });
    clips.push(clip);
  }

  await transcriber.release();
  return {
    model: model.file,
    label: model.label,
    loadMs: roundToTenth(loadMs),
    warmMs: roundToTenth(warmMs),
    clips,
  };
};

const seconds = durationsSchema.parse(listCommaSeparatedList(fields.seconds));

const runs = runsSchema.parse(fields.runs);

const modelKeys = listCommaSeparatedList(fields.models);

const modelReports = [];
for (const key of modelKeys) {
  const modelReport = await readBenchModel({ key, seconds, runs });
  modelReports.push(modelReport);
}

const backend = readWhisperBackend();

const benchReport = JSON.stringify(
  {
    backend,
    note: "decodeMs is VAD + Whisper on synthetic speech-like audio with a warm model; loadMs is the one-time cold start.",
    models: modelReports,
  },
  null,
  2,
);

process.stdout.write(`${benchReport}\n`);
