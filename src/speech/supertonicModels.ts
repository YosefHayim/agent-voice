/** Supertonic 3 TTS models: four ONNX graphs, their config, the character index, and the ten voice styles. */

import { existsSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { downloadFile, type ModelDownloadError } from "../files/modelDownload.js";
import { speechVoices } from "../settings/configSchema.js";
import { stateFolder } from "../settings/voxkeyHome.js";

// The revision the supertonic 1.3.1 PyPI package pinned, so voices sound exactly as before.
const SUPERTONIC_REVISION = "724fb5abbf5502583fb520898d45929e62f02c0b";

const SUPERTONIC_REPOSITORY = "https://huggingface.co/Supertone/supertonic-3/resolve";

export const supertonicFiles: ReadonlyArray<string> = [
  "onnx/tts.json",
  "onnx/unicode_indexer.json",
  "onnx/duration_predictor.onnx",
  "onnx/text_encoder.onnx",
  "onnx/vector_estimator.onnx",
  "onnx/vocoder.onnx",
  ...speechVoices.map((voice) => `voice_styles/${voice}.json`),
];

export const supertonicFolder = (): string => path.join(stateFolder("models"), "supertonic-3");

export const missingSupertonicFiles = (): ReadonlyArray<string> =>
  supertonicFiles.filter((file) => !existsSync(path.join(supertonicFolder(), file)));

/** Download whichever Supertonic files are missing (about 400 MB the first time). */
export const ensureSupertonicModels = (
  onProgress: (file: string, receivedBytes: number) => void,
): Effect.Effect<string, ModelDownloadError> =>
  Effect.as(
    Effect.forEach(missingSupertonicFiles(), (file) =>
      downloadFile({
        url: `${SUPERTONIC_REPOSITORY}/${SUPERTONIC_REVISION}/${file}`,
        destination: path.join(supertonicFolder(), file),
        onProgress: (receivedBytes) => onProgress(file, receivedBytes),
      }),
    ),
    supertonicFolder(),
  );
