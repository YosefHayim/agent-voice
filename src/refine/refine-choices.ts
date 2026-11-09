import { z } from "zod";
import { stateFile } from "#src/settings/agent-voice-home.js";
import {
  readJsonFile,
  readTextIfPresent,
  readTextIfReadable,
  writeFileAtomically,
  writeJsonAtomically,
} from "#src/storage/state-files.js";
import { nonBlankLines } from "./agent-cli.js";

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
  readJsonFile({ path: stateFile(CHOICE_FILE), schema: savedChoiceSchema });

export const codexLastGoodModel = (): string => {
  const lastGoodFile = stateFile(CODEX_LAST_GOOD_FILE);
  return (readTextIfReadable(lastGoodFile) ?? "").trim();
};

const modelSet = (fileText: string | null): ReadonlySet<string> => {
  const models = nonBlankLines(fileText ?? "");
  return new Set(models);
};

// Null when the file exists but cannot be read, so an update never replaces it unseen.
const readCodexFailedModels = (): ReadonlySet<string> | null => {
  const failedFile = stateFile(CODEX_FAILED_FILE);
  try {
    return modelSet(readTextIfPresent(failedFile));
  } catch {
    return null;
  }
};

export const codexFailedModels = (): ReadonlySet<string> => readCodexFailedModels() ?? new Set<string>();

const writeCodexFailedModels = (failed: ReadonlySet<string>): void => {
  const lines = [...failed].sort().map((model) => `${model}\n`);
  writeFileAtomically({ path: stateFile(CODEX_FAILED_FILE), contents: lines.join("") });
};

export const markCodexModelFailed = (model: string): void => {
  const trimmed = model.trim();
  const failed = readCodexFailedModels();
  const isUnreadable = failed === null;
  if (isUnreadable || trimmed === "" || failed.has(trimmed)) {
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
  if (model === "") {
    return;
  }

  writeJsonAtomically({
    path: stateFile(CHOICE_FILE),
    value: {
      provider: request.provider,
      model,
      effort: request.effort || DEFAULT_REFINE_EFFORT,
      updatedAt: Date.now() / 1_000,
    },
  });
  const isNotCodex = request.provider !== "codex";
  if (isNotCodex) {
    return;
  }

  writeFileAtomically({ path: stateFile(CODEX_LAST_GOOD_FILE), contents: `${model}\n` });
  const failed = readCodexFailedModels();
  const isModelNotMarkedFailed = failed === null || !failed.has(model);
  if (isModelNotMarkedFailed) {
    return;
  }

  const remaining = [...failed].filter((name) => name !== model);
  const updated = new Set(remaining);
  writeCodexFailedModels(updated);
};
