/**
 * Saved refine choices in ~/.voxkey: the sticky provider/model/effort pick, and the Codex last-good and
 * failed-model lists, so the next dictation skips models that already failed for this account.
 */

import { Either, Option, Schema } from "effect";
import {
  readJsonFile,
  readTextIfPresent,
  readTextIfReadable,
  writeFileAtomically,
  writeJsonAtomically,
} from "../files/stateFiles.js";
import { stateFile } from "../settings/voxkeyHome.js";

export const DEFAULT_REFINE_MODEL = "gpt-5.3-codex-spark";

/** Low effort keeps dictation refine fast; Codex reasoning models otherwise default to xhigh. */
export const DEFAULT_REFINE_EFFORT = "low";

export const savedChoiceSchema = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  updatedAt: Schema.Number,
});

export type SavedChoice = Schema.Schema.Type<typeof savedChoiceSchema>;

export const readSavedChoice = (): Option.Option<SavedChoice> =>
  readJsonFile({ path: stateFile("refine-choice.json"), schema: savedChoiceSchema });

export const codexLastGoodModel = (): string =>
  Option.getOrElse(readTextIfReadable(stateFile("refine-codex-last-good.txt")), () => "").trim();

/** The failed-model list; a left when the file exists but cannot be read, so an update never replaces it unseen. */
const readCodexFailedModels = (): Either.Either<ReadonlySet<string>, unknown> =>
  Either.map(
    Either.try(() => readTextIfPresent(stateFile("refine-codex-failed.txt"))),
    (text) =>
      new Set(
        Option.getOrElse(text, () => "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      ),
  );

export const codexFailedModels = (): ReadonlySet<string> =>
  Either.getOrElse(readCodexFailedModels(), () => new Set<string>());

const writeCodexFailedModels = (failed: ReadonlySet<string>): void =>
  writeFileAtomically({
    path: stateFile("refine-codex-failed.txt"),
    text: [...failed].sort().join("\n") + (failed.size > 0 ? "\n" : ""),
  });

export const markCodexModelFailed = (model: string): void => {
  const failed = readCodexFailedModels();
  if (Either.isLeft(failed) || model.trim() === "" || failed.right.has(model.trim())) {
    return;
  }

  writeCodexFailedModels(new Set([...failed.right, model.trim()]));
};

/** Remember the pick for the next refine; a Codex model also becomes last-good and loses its failed mark. */
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
    path: stateFile("refine-choice.json"),
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

  writeFileAtomically({ path: stateFile("refine-codex-last-good.txt"), text: `${model}\n` });
  const failed = readCodexFailedModels();
  if (Either.isRight(failed) && failed.right.has(model)) {
    writeCodexFailedModels(new Set([...failed.right].filter((name) => name !== model)));
  }
};
