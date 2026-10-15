/** `status.json`: the dictation worker's stage, read by the pill every 80 ms and by `voxkey status`. */

import { Option, Schema } from "effect";
import { readJsonFile, writeJsonAtomically } from "../files/stateFiles.js";
import { stateFile } from "../settings/voxkeyHome.js";

export const dictationStageSchema = Schema.Literal(
  "starting",
  "inactive",
  "listening",
  "finishing",
  "refining",
  "done",
  "unavailable",
);

export type DictationStage = Schema.Schema.Type<typeof dictationStageSchema>;

export const workerStatusSchema = Schema.Struct({
  stage: dictationStageSchema,
  detail: Schema.String.annotations({ description: "Short text for the pill and `voxkey status`." }),
  preview: Schema.String.annotations({ description: "Live caption while Shift is held; never typed." }),
  recording: Schema.Boolean.annotations({
    description: "True while the mic captures a confirmed hold, through its release tail; speech waits.",
  }),
  model: Schema.String,
  backend: Schema.String,
  updatedAt: Schema.Number,
});

export type WorkerStatus = Schema.Schema.Type<typeof workerStatusSchema>;

export const readWorkerStatus = (): Option.Option<WorkerStatus> =>
  readJsonFile({ path: stateFile("status.json"), schema: workerStatusSchema });

export const writeWorkerStatus = (status: Omit<WorkerStatus, "updatedAt">): void =>
  writeJsonAtomically({ path: stateFile("status.json"), value: { ...status, updatedAt: Date.now() / 1_000 } });

/**
 * Status writes for the loaded model, so callers pass only the stage and the detail. Every write records whether
 * the mic is capturing a hold, so a queued clip's "finishing" or "refining" never lets speech into a newer one.
 */
export const makeStatusWriter = (request: {
  readonly model: string;
  readonly backend: string;
  readonly recording: () => boolean;
}) => {
  const fields = () => ({ model: request.model, backend: request.backend, recording: request.recording() });
  return {
    write: (stage: DictationStage, detail: string) => writeWorkerStatus({ ...fields(), stage, detail, preview: "" }),
    writePreview: (caption: string) =>
      writeWorkerStatus({ ...fields(), stage: "listening", detail: "", preview: caption }),
    stage: (): Option.Option<DictationStage> => Option.map(readWorkerStatus(), (status) => status.stage),
  };
};

export type StatusWriter = ReturnType<typeof makeStatusWriter>;

/** Speech waits while the dictation worker starts and while a hold is being captured (release tail included). */
export const dictationOwnsAudio = (): boolean =>
  Option.exists(readWorkerStatus(), (status) => status.stage === "starting" || status.recording);
