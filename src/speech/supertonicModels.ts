import { existsSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { downloadFile, type ModelDownloadError } from "../files/modelDownload.js";
import { stateFolder } from "../settings/agentVoiceHome.js";
import { speechVoices } from "../settings/configSchema.js";

// The revision the supertonic 1.3.1 PyPI package pinned, so voices sound exactly as before.
const SUPERTONIC_REVISION = "724fb5abbf5502583fb520898d45929e62f02c0b";

const SUPERTONIC_REPOSITORY = "https://huggingface.co/Supertone/supertonic-3/resolve";

const supertonicFiles: ReadonlyArray<string> = [
  "onnx/tts.json",
  "onnx/unicode_indexer.json",
  "onnx/duration_predictor.onnx",
  "onnx/text_encoder.onnx",
  "onnx/vector_estimator.onnx",
  "onnx/vocoder.onnx",
  ...speechVoices.map((voice) => `voice_styles/${voice}.json`),
];

export const supertonicFolder = (): string => {
  const modelsFolder = stateFolder("models");
  return path.join(modelsFolder, "supertonic-3");
};

export const missingSupertonicFiles = (): ReadonlyArray<string> => {
  const folder = supertonicFolder();
  return supertonicFiles.filter((file) => {
    const filePath = path.join(folder, file);
    return !existsSync(filePath);
  });
};

export const ensureSupertonicModels = (
  onProgress: (file: string, receivedBytes: number) => void,
): Effect.Effect<string, ModelDownloadError> => {
  const folder = supertonicFolder();
  const missingFiles = missingSupertonicFiles();
  const downloads = Effect.forEach(missingFiles, (file) =>
    downloadFile({
      url: `${SUPERTONIC_REPOSITORY}/${SUPERTONIC_REVISION}/${file}`,
      destination: path.join(folder, file),
      onProgress: (receivedBytes) => onProgress(file, receivedBytes),
    }),
  );
  return Effect.as(downloads, folder);
};
