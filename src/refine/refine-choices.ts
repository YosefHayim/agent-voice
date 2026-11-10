import { z } from "zod";
import { readStatusFile } from "#src/settings/agent-voice-home.js";
import {
  readDocumentFile,
  readFileIfExists,
  readFileIfReadable,
  writeDocumentAtomically,
  writeFileAtomically,
} from "#src/storage/state-files.js";
import { listNonBlankLines } from "./agent-cli.js";

export const DEFAULT_REFINE_MODEL = "gpt-5.3-codex-spark";

// Low effort keeps dictation refine fast; Codex reasoning models otherwise default to xhigh.
export const DEFAULT_REFINE_EFFORT = "low";

const savedChoiceSchema = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  updatedAt: z.number(),
});

export type SavedChoice = z.infer<typeof savedChoiceSchema>;

const CHOICE_FILE = "refine-choice.json";
const CODEX_LAST_GOOD_FILE = "refine-codex-last-good.txt";
const CODEX_FAILED_FILE = "refine-codex-failed.txt";

export const readSavedChoice = (): SavedChoice | null =>
  readDocumentFile({ path: readStatusFile(CHOICE_FILE), schema: savedChoiceSchema });

export const readCodexLastGoodModel = (): string => {
  const lastGoodFile = readStatusFile(CODEX_LAST_GOOD_FILE);
  return (readFileIfReadable(lastGoodFile) ?? "").trim();
};

const readModelSet = (modelListFileReading: string | null): ReadonlySet<string> => {
  const models = listNonBlankLines(modelListFileReading ?? "");
  return new Set(models);
};

// Null when the file exists but cannot be read, so an update never replaces it unseen.
const readCodexFailedModelsOrNull = (): ReadonlySet<string> | null => {
  const failedFile = readStatusFile(CODEX_FAILED_FILE);
  try {
    return readModelSet(readFileIfExists(failedFile));
  } catch {
    return null;
  }
};

export const readCodexFailedModels = (): ReadonlySet<string> => readCodexFailedModelsOrNull() ?? new Set<string>();

const writeCodexFailedModels = (failed: ReadonlySet<string>): void => {
  const lines = [...failed].sort().map((model) => `${model}\n`);
  writeFileAtomically({ path: readStatusFile(CODEX_FAILED_FILE), contents: lines.join("") });
};

export const markCodexModelFailed = (model: string): void => {
  const trimmed = model.trim();
  const failed = readCodexFailedModelsOrNull();

  const isUnreadable = failed == null;

  const isChoiceUnusable = isUnreadable || trimmed === "" || failed.has(trimmed);
  if (isChoiceUnusable) {
    return;
  }

  const updated = new Set([...failed, trimmed]);
  writeCodexFailedModels(updated);
};

// A Codex model also becomes last-good and loses its failed mark.
export const saveRefineChoice = (request: {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}): void => {
  const model = request.model.trim();

  const isModelEmpty = model === "";
  if (isModelEmpty) {
    return;
  }

  const millisecondsPerSecond = 1_000;

  writeDocumentAtomically({
    path: readStatusFile(CHOICE_FILE),
    value: {
      provider: request.provider,
      model,
      effort: request.effort || DEFAULT_REFINE_EFFORT,
      updatedAt: Date.now() / millisecondsPerSecond,
    },
  });

  const isNotCodex = request.provider !== "codex";
  if (isNotCodex) {
    return;
  }

  writeFileAtomically({ path: readStatusFile(CODEX_LAST_GOOD_FILE), contents: `${model}\n` });
  const failed = readCodexFailedModelsOrNull();

  const isModelNotMarkedFailed = failed == null || !failed.has(model);
  if (isModelNotMarkedFailed) {
    return;
  }

  const remaining = [...failed].filter((name) => name !== model);
  const updated = new Set(remaining);
  writeCodexFailedModels(updated);
};
