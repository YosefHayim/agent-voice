// Whisper ggml models: which file dictation loads, where it lives, and where it downloads from.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { stateFolder } from "#src/settings/agent-voice-home.js";
import type { Config } from "#src/settings/config-schema.js";
import type { AgentVoiceEnvironment } from "#src/settings/environment-variables.js";
import { downloadFile } from "#src/storage/model-download.js";

export const whisperModelKeys = ["tiny", "base", "small", "turbo-q5", "turbo-q8", "turbo", "ivrit"] as const;

type WhisperModelKey = (typeof whisperModelKeys)[number];

interface WhisperModel {
  readonly key: WhisperModelKey;
  readonly file: string;
  readonly label: string;
  readonly url: string;
  readonly approximateBytes: number;
}

const ggerganov = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}?download=true`;

export const whisperModels: ReadonlyArray<WhisperModel> = [
  {
    key: "tiny",
    file: "ggml-tiny.en.bin",
    label: "Tiny English (fastest)",
    url: ggerganov("ggml-tiny.en.bin"),
    approximateBytes: 78_000_000,
  },
  {
    key: "base",
    file: "ggml-base.en.bin",
    label: "Base English",
    url: ggerganov("ggml-base.en.bin"),
    approximateBytes: 148_000_000,
  },
  {
    key: "small",
    file: "ggml-small.en.bin",
    label: "Small English",
    url: ggerganov("ggml-small.en.bin"),
    approximateBytes: 488_000_000,
  },
  {
    key: "turbo-q5",
    file: "ggml-large-v3-turbo-q5_0.bin",
    label: "Turbo V3 small (q5_0)",
    url: ggerganov("ggml-large-v3-turbo-q5_0.bin"),
    approximateBytes: 574_000_000,
  },
  {
    key: "turbo-q8",
    file: "ggml-large-v3-turbo-q8_0.bin",
    label: "Turbo V3 medium (q8_0)",
    url: ggerganov("ggml-large-v3-turbo-q8_0.bin"),
    approximateBytes: 874_000_000,
  },
  {
    key: "turbo",
    file: "ggml-large-v3-turbo.bin",
    label: "Turbo V3 large",
    url: ggerganov("ggml-large-v3-turbo.bin"),
    approximateBytes: 1_624_000_000,
  },
  {
    key: "ivrit",
    file: "ggml-ivrit-large-v3-turbo.bin",
    label: "ivrit.ai Hebrew Turbo V3",
    url: "https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin?download=true",
    approximateBytes: 1_624_555_275,
  },
];

export const MODEL_ALIASES: Readonly<Record<string, WhisperModelKey>> = {
  tiny: "tiny",
  "tiny.en": "tiny",
  fast: "tiny",
  base: "base",
  "base.en": "base",
  small: "small",
  "small.en": "small",
  turbo: "turbo",
  large: "turbo",
  "turbo-full": "turbo",
  "turbo-q8": "turbo-q8",
  q8: "turbo-q8",
  medium: "turbo-q8",
  "turbo-q5": "turbo-q5",
  ivrit: "ivrit",
  "ivrit-ai": "ivrit",
  hebrew: "ivrit",
  he: "ivrit",
  "he-il": "ivrit",
};

const pickWhisperModel = (key: WhisperModelKey): WhisperModel =>
  whisperModels.find((model) => model.key === key) ?? whisperModels[3];

// AGENT_VOICE_DICTATION_MODEL wins (an unknown name means turbo-q5), then the dictation-model setting; auto follows the language: Hebrew picks ivrit.ai and English turbo-q5.
export const selectWhisperModel = (request: {
  readonly environment: AgentVoiceEnvironment;
  readonly config: Config;
}): WhisperModel => {
  const forced = request.environment.AGENT_VOICE_DICTATION_MODEL.toLowerCase();

  const isForced = forced !== "";
  if (isForced) {
    return pickWhisperModel(MODEL_ALIASES[forced] ?? "turbo-q5");
  }

  const chosenKey = request.config.dictationModel;

  const isChosen = chosenKey !== "auto";
  if (isChosen) {
    return pickWhisperModel(chosenKey);
  }

  const isDictationLanguageHe = request.config.dictationLanguage === "he";
  if (isDictationLanguageHe) {
    return pickWhisperModel("ivrit");
  }

  return pickWhisperModel("turbo-q5");
};

export const whisperModelPath = (model: WhisperModel): string => {
  const modelsFolder = stateFolder("models");
  return path.join(modelsFolder, model.file);
};

// A file under 1 MB is a failed download, not a model.
const failedDownloadBytes = 1_000_000;

export const isWhisperModelPresent = (model: WhisperModel): boolean => {
  const file = whisperModelPath(model);

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
  const modelPath = whisperModelPath(request.model);

  const isModelPresent = isWhisperModelPresent(request.model);
  if (isModelPresent) {
    return modelPath;
  }

  await downloadFile({ url: request.model.url, destination: modelPath, onProgress: request.onProgress });
  return modelPath;
};
