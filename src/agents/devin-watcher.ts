import { z } from "zod";
import { describeError } from "#src/error-message.js";
import { sleep } from "#src/sleep.js";
import { queueReply } from "#src/speech/inbox.js";
import { readDocumentFile } from "#src/storage/state-files.js";
import { appendSpeechLog } from "#src/workers/worker-log.js";

const atifExportSchema = z.object({
  steps: z.array(
    z.object({
      step_id: z.string().optional(),
      source: z.string().optional(),
      message: z.unknown().optional(),
    }),
  ),
});

type AtifExport = z.infer<typeof atifExportSchema>;

interface DevinTurn {
  readonly markdown: string;
  readonly turnId: string;
}

interface WatchStatus {
  readonly spokenTurn: string;
  readonly pendingTurn: string;
  readonly changedAt: number;
}

const noTurn: DevinTurn = { markdown: "", turnId: "" };

const TURN_SETTLE_MS = 800;

const POLL_INTERVAL_MS = 200;

// After Devin exits, long enough for a turn written as it exits to be seen, settle, and be queued.
const exitGracePollCount = 2;

const exitGraceMilliseconds = TURN_SETTLE_MS + exitGracePollCount * POLL_INTERVAL_MS;

export const readLatestDevinTurn = (atif: AtifExport): DevinTurn => {
  const lastUser = atif.steps.map((step) => step.source).lastIndexOf("user");
  const agentSteps = atif.steps
    .slice(lastUser + 1)
    .filter((step) => step.source === "agent")
    .flatMap((step) => {
      const stepMessage = step.message;
      const isStepMessageGiven = typeof stepMessage === "string";
      const message = isStepMessageGiven ? stepMessage.trim() : "";

      const isMessageEmpty = message === "";
      if (isMessageEmpty) {
        return [];
      }

      return [{ message, turnId: step.step_id || "" }];
    });
  const namedSteps = agentSteps.filter((step) => step.turnId !== "");
  return {
    markdown: agentSteps.map((step) => step.message).join("\n\n"),
    turnId: namedSteps.at(-1)?.turnId || "",
  };
};

const readTurn = (exportFile: string): DevinTurn => {
  const savedExport = readDocumentFile({ path: exportFile, schema: atifExportSchema });

  const isThereNoSavedExport = savedExport == null;
  if (isThereNoSavedExport) {
    return noTurn;
  }

  return readLatestDevinTurn(savedExport);
};

// Returns the turn now spoken. A turn that cannot be queued is logged and passed over, so the watcher keeps reading
// later turns.
const confirmTurn = (request: {
  readonly exportFile: string;
  readonly pendingTurn: string;
  readonly spokenTurn: string;
}): string => {
  const confirmed = readTurn(request.exportFile);

  const isConfirmedTurnUnusable = confirmed.turnId !== request.pendingTurn || confirmed.markdown === "";
  if (isConfirmedTurnUnusable) {
    return request.spokenTurn;
  }

  try {
    queueReply({
      markdown: confirmed.markdown,
      source: "devin",
      agentReplyId: confirmed.turnId,
      origin: { kind: "terminal" },
    });
  } catch (error) {
    appendSpeechLog(`devin turn ${confirmed.turnId} not queued: ${describeError(error)}`);
  }
  return confirmed.turnId;
};

const trackTurn = (watchStatus: WatchStatus, turnId: string): WatchStatus => {
  const isNotNewTurn = turnId === "" || turnId === watchStatus.spokenTurn || turnId === watchStatus.pendingTurn;
  if (isNotNewTurn) {
    return watchStatus;
  }

  return { ...watchStatus, pendingTurn: turnId, changedAt: Date.now() };
};

const settleTurn = (exportFile: string, watchStatus: WatchStatus): WatchStatus => {
  const isNotSettled = watchStatus.pendingTurn === "" || Date.now() - watchStatus.changedAt < TURN_SETTLE_MS;
  if (isNotSettled) {
    return watchStatus;
  }

  const spokenTurn = confirmTurn({
    exportFile,
    pendingTurn: watchStatus.pendingTurn,
    spokenTurn: watchStatus.spokenTurn,
  });
  return { ...watchStatus, spokenTurn, pendingTurn: "" };
};

const pollTurn = (exportFile: string, watchStatus: WatchStatus): WatchStatus => {
  const latest = readTurn(exportFile);
  const tracked = trackTurn(watchStatus, latest.turnId);
  return settleTurn(exportFile, tracked);
};

const watchDevinExport = async (exportFile: string, shutdown: AbortSignal): Promise<void> => {
  try {
    const firstTurn = readTurn(exportFile);
    let watchStatus: WatchStatus = { spokenTurn: firstTurn.turnId, pendingTurn: "", changedAt: Date.now() };
    while (!shutdown.aborted) {
      watchStatus = pollTurn(exportFile, watchStatus);
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    appendSpeechLog(`devin watcher stopped: ${describeError(error)}`);
  }
};

// The watcher stops with the session however it ends, a Devin that never started included.
export const watchDevinSession = async <SessionReport>(request: {
  readonly exportFile: string;
  readonly readSession: () => Promise<SessionReport>;
}): Promise<SessionReport> => {
  const shutdown = new AbortController();
  const watcher = watchDevinExport(request.exportFile, shutdown.signal);
  try {
    const sessionReport = await request.readSession();
    await sleep(exitGraceMilliseconds);
    return sessionReport;
  } finally {
    shutdown.abort();
    await watcher;
  }
};
