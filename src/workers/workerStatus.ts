import { Option, Schema } from "effect";
import { readJsonFile, writeJsonAtomically } from "../files/stateFiles.js";
import { stateFile } from "../settings/agentVoiceHome.js";

const dictationStageSchema = Schema.Literal(
  "starting",
  "inactive",
  "listening",
  "finishing",
  "refining",
  "done",
  "unavailable",
);

type DictationStage = Schema.Schema.Type<typeof dictationStageSchema>;

// status.json is read by the pill every 80 ms and by `agent-voice status`.
const workerStatusSchema = Schema.Struct({
  stage: dictationStageSchema,
  detail: Schema.String.annotations({ description: "Short text for the pill and `agent-voice status`." }),
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

// Every write records whether the mic is capturing a hold, so a queued clip's "finishing" or "refining" never lets
// speech into a newer hold.
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
    stage: (): Option.Option<DictationStage> => readWorkerStatus().pipe(Option.map((status) => status.stage)),
  };
};

export type StatusWriter = ReturnType<typeof makeStatusWriter>;

// Speech waits while the dictation worker starts and while a hold is captured, release tail included.
export const dictationOwnsAudio = (): boolean =>
  readWorkerStatus().pipe(Option.exists((status) => status.stage === "starting" || status.recording));
