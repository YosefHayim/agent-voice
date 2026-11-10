import { z } from "zod";

import { readStatusFile } from "#src/settings/agent-voice-home.js";
import { readDocumentFile, writeDocumentAtomically } from "#src/storage/state-files.js";

const STATUS_FILE_NAME = "status.json";

const LISTENING_STAGE = "listening";

const STARTING_STAGE = "starting";

const dictationStages = [
  STARTING_STAGE,
  "inactive",
  LISTENING_STAGE,
  "finishing",
  "refining",
  "done",
  "unavailable",
] as const;

type DictationStage = (typeof dictationStages)[number];

// status.json is read by the pill every 80 ms and by `agent-voice status`.
const workerStatusSchema = z.object({
  stage: z.enum(dictationStages),
  // Short text for the pill and `agent-voice status`.
  detail: z.string(),
  // Live caption while the hold key is held; never typed.
  preview: z.string(),
  // True while the mic captures a confirmed hold, through its release tail; speech waits.
  recording: z.boolean(),
  model: z.string(),
  backend: z.string(),
  updatedAt: z.number(),
});

type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const readWorkerStatus = (): WorkerStatus | null =>
  readDocumentFile({ path: readStatusFile(STATUS_FILE_NAME), schema: workerStatusSchema });

const millisecondsPerSecond = 1_000;

export const writeWorkerStatus = (status: Omit<WorkerStatus, "updatedAt">): void =>
  writeDocumentAtomically({
    path: readStatusFile(STATUS_FILE_NAME),
    value: { ...status, updatedAt: Date.now() / millisecondsPerSecond },
  });

// Every write records whether the mic is capturing a hold, so a queued clip's "finishing" or "refining" never lets
// speech into a newer hold.
export const makeStatusWriter = (request: {
  readonly model: string;
  readonly backend: string;
  readonly recording: () => boolean;
}) => {
  const readStatusFields = () => ({ model: request.model, backend: request.backend, recording: request.recording() });
  return {
    write: (stage: DictationStage, detail: string) =>
      writeWorkerStatus({ ...readStatusFields(), stage, detail, preview: "" }),
    writePreview: (caption: string) =>
      writeWorkerStatus({ ...readStatusFields(), stage: LISTENING_STAGE, detail: "", preview: caption }),
    stage: (): DictationStage | null => readWorkerStatus()?.stage ?? null,
  };
};

export type StatusWriter = ReturnType<typeof makeStatusWriter>;

// Speech waits while the dictation worker starts and while a hold is captured, release tail included.
export const isAudioOwnedByDictation = (): boolean => {
  const status = readWorkerStatus();

  const isThereNoStatus = status == null;
  if (isThereNoStatus) {
    return false;
  }

  const isStarting = status.stage === STARTING_STAGE;
  return isStarting || status.recording;
};
