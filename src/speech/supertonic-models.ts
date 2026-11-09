import { existsSync } from "node:fs";
import path from "node:path";

import { stateFolder } from "#src/settings/agent-voice-home.js";
import { speechVoices } from "#src/settings/config-schema.js";
import { downloadFile } from "#src/storage/model-download.js";

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

// Downloads one file at a time, pinned to the revision the supertonic 1.3.1 PyPI package used, so voices sound the same.
export const ensureSupertonicModels = async (
  onProgress: (file: string, receivedBytes: number) => void,
): Promise<string> => {
  const folder = supertonicFolder();
  const missingFiles = missingSupertonicFiles();

  for (const file of missingFiles) {
    await downloadFile({
      url: `https://huggingface.co/Supertone/supertonic-3/resolve/724fb5abbf5502583fb520898d45929e62f02c0b/${file}`,
      destination: path.join(folder, file),
      onProgress: (receivedBytes) => onProgress(file, receivedBytes),
    });
  }

  return folder;
};
