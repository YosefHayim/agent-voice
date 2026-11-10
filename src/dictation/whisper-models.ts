// Whisper ggml models: which file dictation loads, where it lives, and where it downloads from.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { readStatusFolder } from "#src/settings/agent-voice-home.js";
import type { Settings } from "#src/settings/config-schema.js";
import type { AgentVoiceEnvironment } from "#src/settings/environment-variables.js";
import { downloadFile } from "#src/storage/model-download.js";

const TURBO_MODEL_FILE = "ggml-large-v3-turbo.bin";

const TURBO_Q8_MODEL_FILE = "ggml-large-v3-turbo-q8_0.bin";

const TURBO_Q5_MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";

const SMALL_MODEL_FILE = "ggml-small.en.bin";

const BASE_MODEL_FILE = "ggml-base.en.bin";

const TINY_MODEL_FILE = "ggml-tiny.en.bin";

const IVRIT_MODEL_KEY = "ivrit";

const TURBO_MODEL_KEY = "turbo";

const TURBO_Q8_MODEL_KEY = "turbo-q8";

const TURBO_Q5_MODEL_KEY = "turbo-q5";

const SMALL_MODEL_KEY = "small";

const BASE_MODEL_KEY = "base";

const TINY_MODEL_KEY = "tiny";

export const whisperModelKeys = [
  TINY_MODEL_KEY,
  BASE_MODEL_KEY,
  SMALL_MODEL_KEY,
  TURBO_Q5_MODEL_KEY,
  TURBO_Q8_MODEL_KEY,
  TURBO_MODEL_KEY,
  IVRIT_MODEL_KEY,
] as const;

type WhisperModelKey = (typeof whisperModelKeys)[number];

interface WhisperModel {
  readonly key: WhisperModelKey;
  readonly file: string;
  readonly label: string;
  readonly url: string;
  readonly approximateBytes: number;
}

const createModelUrl = (file: string) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}?download=true`;

const ivritApproximateBytes = 1_624_555_275;

const turboApproximateBytes = 1_624_000_000;

const turboQ8ApproximateBytes = 874_000_000;

const turboQ5ApproximateBytes = 574_000_000;

const smallApproximateBytes = 488_000_000;

const baseApproximateBytes = 148_000_000;

const tinyApproximateBytes = 78_000_000;

export const whisperModels: ReadonlyArray<WhisperModel> = [
  {
    key: TINY_MODEL_KEY,
    file: TINY_MODEL_FILE,
    label: "Tiny English (fastest)",
    url: createModelUrl(TINY_MODEL_FILE),
    approximateBytes: tinyApproximateBytes,
  },
  {
    key: BASE_MODEL_KEY,
    file: BASE_MODEL_FILE,
    label: "Base English",
    url: createModelUrl(BASE_MODEL_FILE),
    approximateBytes: baseApproximateBytes,
  },
  {
    key: SMALL_MODEL_KEY,
    file: SMALL_MODEL_FILE,
    label: "Small English",
    url: createModelUrl(SMALL_MODEL_FILE),
    approximateBytes: smallApproximateBytes,
  },
  {
    key: TURBO_Q5_MODEL_KEY,
    file: TURBO_Q5_MODEL_FILE,
    label: "Turbo V3 small (q5_0)",
    url: createModelUrl(TURBO_Q5_MODEL_FILE),
    approximateBytes: turboQ5ApproximateBytes,
  },
  {
    key: TURBO_Q8_MODEL_KEY,
    file: TURBO_Q8_MODEL_FILE,
    label: "Turbo V3 medium (q8_0)",
    url: createModelUrl(TURBO_Q8_MODEL_FILE),
    approximateBytes: turboQ8ApproximateBytes,
  },
  {
    key: TURBO_MODEL_KEY,
    file: TURBO_MODEL_FILE,
    label: "Turbo V3 large",
    url: createModelUrl(TURBO_MODEL_FILE),
    approximateBytes: turboApproximateBytes,
  },
  {
    key: IVRIT_MODEL_KEY,
    file: "ggml-ivrit-large-v3-turbo.bin",
    label: "ivrit.ai Hebrew Turbo V3",
    url: "https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin?download=true",
    approximateBytes: ivritApproximateBytes,
  },
];

export const MODEL_ALIASES: Readonly<Record<string, WhisperModelKey>> = {
  tiny: TINY_MODEL_KEY,
  "tiny.en": TINY_MODEL_KEY,
  fast: TINY_MODEL_KEY,
  base: BASE_MODEL_KEY,
  "base.en": BASE_MODEL_KEY,
  small: SMALL_MODEL_KEY,
  "small.en": SMALL_MODEL_KEY,
  turbo: TURBO_MODEL_KEY,
  large: TURBO_MODEL_KEY,
  "turbo-full": TURBO_MODEL_KEY,
  "turbo-q8": TURBO_Q8_MODEL_KEY,
  q8: TURBO_Q8_MODEL_KEY,
  medium: TURBO_Q8_MODEL_KEY,
  "turbo-q5": TURBO_Q5_MODEL_KEY,
  ivrit: IVRIT_MODEL_KEY,
  "ivrit-ai": IVRIT_MODEL_KEY,
  hebrew: IVRIT_MODEL_KEY,
  he: IVRIT_MODEL_KEY,
  "he-il": IVRIT_MODEL_KEY,
};

const pickWhisperModel = (key: WhisperModelKey): WhisperModel =>
  whisperModels.find((model) => model.key === key) ?? whisperModels[3];

// AGENT_VOICE_DICTATION_MODEL wins (an unknown name means turbo-q5), then the dictation-model setting; auto follows the language: Hebrew picks ivrit.ai and English turbo-q5.
export const selectWhisperModel = (request: {
  readonly environment: AgentVoiceEnvironment;
  readonly config: Settings;
}): WhisperModel => {
  const forced = request.environment.AGENT_VOICE_DICTATION_MODEL.toLowerCase();

  const isForced = forced !== "";
  if (isForced) {
    return pickWhisperModel(MODEL_ALIASES[forced] ?? TURBO_Q5_MODEL_KEY);
  }

  const chosenKey = request.config.dictationModel;

  const isChosen = chosenKey !== "auto";
  if (isChosen) {
    return pickWhisperModel(chosenKey);
  }

  const isDictationLanguageHe = request.config.dictationLanguage === "he";
  if (isDictationLanguageHe) {
    return pickWhisperModel(IVRIT_MODEL_KEY);
  }

  return pickWhisperModel(TURBO_Q5_MODEL_KEY);
};

export const readWhisperModelPath = (model: WhisperModel): string => {
  const modelsFolder = readStatusFolder("models");
  return path.join(modelsFolder, model.file);
};

// A file under 1 MB is a failed download, not a model.
const failedDownloadBytes = 1_000_000;

export const isWhisperModelDownloaded = (model: WhisperModel): boolean => {
  const file = readWhisperModelPath(model);

  const isFileAbsent = !existsSync(file);
  if (isFileAbsent) {
    return false;
  }

  const isModelSized = statSync(file).size > failedDownloadBytes;
  return isModelSized;
};

// Returns the model file path, downloading the model first when it is missing.
export const ensureWhisperModel = async (request: {
  readonly model: WhisperModel;
  readonly onProgress: (receivedBytes: number) => void;
}): Promise<string> => {
  const modelPath = readWhisperModelPath(request.model);

  const isModelDownloaded = isWhisperModelDownloaded(request.model);
  if (isModelDownloaded) {
    return modelPath;
  }

  await downloadFile({ url: request.model.url, destination: modelPath, onProgress: request.onProgress });
  return modelPath;
};
