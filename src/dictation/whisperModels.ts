/** Whisper ggml models: which file dictation loads, where it lives, and where it downloads from. */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { Effect, Schema } from "effect";
import { downloadFile, type ModelDownloadError } from "../files/modelDownload.js";
import type { Config } from "../settings/configSchema.js";
import type { VoxkeyEnvironment } from "../settings/environmentVariables.js";
import { stateFolder } from "../settings/voxkeyHome.js";

export const whisperModelSchema = Schema.Struct({
  key: Schema.Literal("tiny", "base", "small", "turbo-q5", "turbo-q8", "turbo", "ivrit"),
  file: Schema.String,
  label: Schema.String,
  url: Schema.String,
  approximateBytes: Schema.Number,
});

export type WhisperModel = Schema.Schema.Type<typeof whisperModelSchema>;

const ggerganov = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}?download=true`;

export const whisperModels: ReadonlyArray<WhisperModel> = Schema.decodeUnknownSync(Schema.Array(whisperModelSchema))([
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
]);

const MODEL_ALIASES: Readonly<Record<string, WhisperModel["key"]>> = {
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

const modelFor = (key: WhisperModel["key"]): WhisperModel =>
  whisperModels.find((model) => model.key === key) ||
  whisperModels[3] || { key, file: "", label: "", url: "", approximateBytes: 0 };

/** VOXKEY_DICTATION_MODEL wins (unknown names mean turbo-q5); otherwise Hebrew picks ivrit.ai and English turbo-q5. */
export const selectWhisperModel = (request: {
  readonly environment: VoxkeyEnvironment;
  readonly config: Config;
}): WhisperModel => {
  const forced = request.environment.VOXKEY_DICTATION_MODEL.toLowerCase();
  if (forced !== "") {
    return modelFor(MODEL_ALIASES[forced] || "turbo-q5");
  }

  return modelFor(request.config.dictationLanguage === "he" ? "ivrit" : "turbo-q5");
};

export const whisperModelPath = (model: WhisperModel): string => path.join(stateFolder("models"), model.file);

/** A file under 1 MB is a failed download, not a model. */
export const isWhisperModelPresent = (model: WhisperModel): boolean => {
  const file = whisperModelPath(model);
  return existsSync(file) && statSync(file).size > 1_000_000;
};

/** The model file, downloaded first when it is missing. */
export const ensureWhisperModel = (request: {
  readonly model: WhisperModel;
  readonly onProgress: (receivedBytes: number) => void;
}): Effect.Effect<string, ModelDownloadError> =>
  isWhisperModelPresent(request.model)
    ? Effect.succeed(whisperModelPath(request.model))
    : Effect.as(
        downloadFile({
          url: request.model.url,
          destination: whisperModelPath(request.model),
          onProgress: request.onProgress,
        }),
        whisperModelPath(request.model),
      );
