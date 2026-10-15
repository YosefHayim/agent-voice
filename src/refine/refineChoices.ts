import { Either, Option, Schema } from "effect";
import {
  readJsonFile,
  readTextIfPresent,
  readTextIfReadable,
  writeFileAtomically,
  writeJsonAtomically,
} from "../files/stateFiles.js";
import { stateFile } from "../settings/agentVoiceHome.js";
import { nonBlankLines } from "./agentCli.js";

export const DEFAULT_REFINE_MODEL = "gpt-5.3-codex-spark";

// Low effort keeps dictation refine fast; Codex reasoning models otherwise default to xhigh.
export const DEFAULT_REFINE_EFFORT = "low";

const savedChoiceSchema = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  updatedAt: Schema.Number,
});

export type SavedChoice = Schema.Schema.Type<typeof savedChoiceSchema>;

const CHOICE_FILE = "refine-choice.json";
const CODEX_LAST_GOOD_FILE = "refine-codex-last-good.txt";
const CODEX_FAILED_FILE = "refine-codex-failed.txt";

export const readSavedChoice = (): Option.Option<SavedChoice> =>
  readJsonFile({ path: stateFile(CHOICE_FILE), schema: savedChoiceSchema });

export const codexLastGoodModel = (): string => {
  const lastGoodFile = stateFile(CODEX_LAST_GOOD_FILE);
  return readTextIfReadable(lastGoodFile).pipe(
    Option.getOrElse(() => ""),
    (text) => text.trim(),
  );
};

const modelSet = (text: Option.Option<string>): ReadonlySet<string> => {
  const fileText = Option.getOrElse(text, () => "");
  const models = nonBlankLines(fileText);
  return new Set(models);
};

// A left when the file exists but cannot be read, so an update never replaces it unseen.
const readCodexFailedModels = (): Either.Either<ReadonlySet<string>, unknown> => {
  const failedFile = stateFile(CODEX_FAILED_FILE);
  return Either.try(() => readTextIfPresent(failedFile)).pipe(Either.map(modelSet));
};

export const codexFailedModels = (): ReadonlySet<string> =>
  readCodexFailedModels().pipe(Either.getOrElse(() => new Set<string>()));

const writeCodexFailedModels = (failed: ReadonlySet<string>): void => {
  const lines = [...failed].sort().map((model) => `${model}\n`);
  writeFileAtomically({ path: stateFile(CODEX_FAILED_FILE), text: lines.join("") });
};

export const markCodexModelFailed = (model: string): void => {
  const trimmed = model.trim();
  const failed = readCodexFailedModels();
  if (Either.isLeft(failed) || trimmed === "" || failed.right.has(trimmed)) {
    return;
  }

  const updated = new Set([...failed.right, trimmed]);
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
  if (request.provider !== "codex") {
    return;
  }

  writeFileAtomically({ path: stateFile(CODEX_LAST_GOOD_FILE), text: `${model}\n` });
  const failed = readCodexFailedModels();
  if (Either.isLeft(failed) || !failed.right.has(model)) {
    return;
  }

  const remaining = [...failed.right].filter((name) => name !== model);
  const updated = new Set(remaining);
  writeCodexFailedModels(updated);
};
