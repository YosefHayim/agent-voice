import { z } from "zod";
import { describeError } from "#src/error-message.js";
import { sleep } from "#src/sleep.js";
import { queueReply } from "#src/speech/inbox.js";
import { readJsonFile } from "#src/storage/state-files.js";
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

interface WatchState {
  readonly spokenTurn: string;
  readonly pendingTurn: string;
  readonly changedAt: number;
}

const noTurn: DevinTurn = { markdown: "", turnId: "" };

// How long a turn ID must stay the same before the turn is queued.
const TURN_SETTLE_MS = 800;

const POLL_INTERVAL_MS = 200;

// After Devin exits, long enough for a turn written as it exits to be seen, settle, and be queued.
const exitGraceMilliseconds = TURN_SETTLE_MS + 2 * POLL_INTERVAL_MS;

// The agent messages after the latest user step, joined; the turn ID is the last agent step's ID.
export const latestDevinTurn = (atif: AtifExport): DevinTurn => {
  const lastUser = atif.steps.map((step) => step.source).lastIndexOf("user");
  const agentSteps = atif.steps
    .slice(lastUser + 1)
    .filter((step) => step.source === "agent")
    .flatMap((step) => {
      const stepMessage = step.message;
      const isMessageText = typeof stepMessage === "string";
      const message = isMessageText ? stepMessage.trim() : "";

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
  const savedExport = readJsonFile({ path: exportFile, schema: atifExportSchema });

  const isThereNoSavedExport = savedExport === null;
  if (isThereNoSavedExport) {
    return noTurn;
  }

  return latestDevinTurn(savedExport);
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

const trackTurn = (state: WatchState, turnId: string): WatchState => {
  const isNotNewTurn = turnId === "" || turnId === state.spokenTurn || turnId === state.pendingTurn;
  if (isNotNewTurn) {
    return state;
  }

  return { ...state, pendingTurn: turnId, changedAt: Date.now() };
};

const settleTurn = (exportFile: string, state: WatchState): WatchState => {
  const isNotSettled = state.pendingTurn === "" || Date.now() - state.changedAt < TURN_SETTLE_MS;
  if (isNotSettled) {
    return state;
  }

  const spokenTurn = confirmTurn({ exportFile, pendingTurn: state.pendingTurn, spokenTurn: state.spokenTurn });
  return { ...state, spokenTurn, pendingTurn: "" };
};

const pollTurn = (exportFile: string, state: WatchState): WatchState => {
  const latest = readTurn(exportFile);
  const tracked = trackTurn(state, latest.turnId);
  return settleTurn(exportFile, tracked);
};

// Polls until shutdown is aborted. A read failure is logged and ends the watch.
const watchDevinExport = async (exportFile: string, shutdown: AbortSignal): Promise<void> => {
  try {
    const firstTurn = readTurn(exportFile);
    let state: WatchState = { spokenTurn: firstTurn.turnId, pendingTurn: "", changedAt: Date.now() };
    while (!shutdown.aborted) {
      state = pollTurn(exportFile, state);
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    appendSpeechLog(`devin watcher stopped: ${describeError(error)}`);
  }
};

// The watcher stops with the session however it ends, a Devin that never started included.
export const watchDevinSession = async <SessionResult>(request: {
  readonly exportFile: string;
  readonly session: () => Promise<SessionResult>;
}): Promise<SessionResult> => {
  const shutdown = new AbortController();
  const watcher = watchDevinExport(request.exportFile, shutdown.signal);
  try {
    const sessionResult = await request.session();
    await sleep(exitGraceMilliseconds);
    return sessionResult;
  } finally {
    shutdown.abort();
    await watcher;
  }
};
