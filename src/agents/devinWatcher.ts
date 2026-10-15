import { Effect, Fiber, Option, Ref, Schema } from "effect";
import { readJsonFile } from "../files/stateFiles.js";
import { queueReply } from "../speech/inbox.js";
import { appendSpeechLog } from "../workers/workerLog.js";

const atifExportSchema = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      step_id: Schema.optional(Schema.String),
      source: Schema.optional(Schema.String),
      message: Schema.optional(Schema.Unknown),
    }),
  ),
});

type AtifExport = Schema.Schema.Type<typeof atifExportSchema>;

const devinTurnSchema = Schema.Struct({ markdown: Schema.String, turnId: Schema.String });

type DevinTurn = Schema.Schema.Type<typeof devinTurnSchema>;

type WatchState = { readonly spokenTurn: string; readonly pendingTurn: string; readonly changedAt: number };

const noTurn: DevinTurn = { markdown: "", turnId: "" };

// How long a turn ID must stay the same before the turn is queued.
const TURN_SETTLE_MS = 800;

const POLL_INTERVAL_MS = 200;

// After Devin exits, long enough for a turn written as it exits to be seen, settle, and be queued.
const EXIT_GRACE_MS = TURN_SETTLE_MS + 2 * POLL_INTERVAL_MS;

const pollPause = Effect.sleep(POLL_INTERVAL_MS);

const exitGrace = Effect.sleep(EXIT_GRACE_MS);

const decodeString = Schema.decodeUnknownOption(Schema.String);

// The agent messages after the latest user step, joined; the turn ID is the last agent step's ID.
export const latestDevinTurn = (atif: AtifExport): DevinTurn => {
  const lastUser = atif.steps.map((step) => step.source).lastIndexOf("user");
  const agentSteps = atif.steps
    .slice(lastUser + 1)
    .filter((step) => step.source === "agent")
    .flatMap((step) => {
      const message = decodeString(step.message)
        .pipe(Option.getOrElse(() => ""))
        .trim();
      if (message === "") {
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

const readTurn = (exportFile: string): DevinTurn =>
  readJsonFile({ path: exportFile, schema: atifExportSchema }).pipe(
    Option.map(latestDevinTurn),
    Option.getOrElse(() => noTurn),
  );

// Returns the turn now spoken. A turn that cannot be queued is logged and passed over, so the watcher keeps reading
// later turns.
const confirmTurn = (request: {
  readonly exportFile: string;
  readonly pendingTurn: string;
  readonly spokenTurn: string;
}) => {
  const confirmed = readTurn(request.exportFile);
  if (confirmed.turnId !== request.pendingTurn || confirmed.markdown === "") {
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
    appendSpeechLog(`devin turn ${confirmed.turnId} not queued: ${String(error)}`);
  }
  return confirmed.turnId;
};

const trackTurn = (state: WatchState, turnId: string): WatchState => {
  const isNewTurn = turnId !== "" && turnId !== state.spokenTurn && turnId !== state.pendingTurn;
  if (!isNewTurn) {
    return state;
  }

  return { ...state, pendingTurn: turnId, changedAt: Date.now() };
};

const settleTurn = (exportFile: string, state: WatchState): WatchState => {
  const hasSettled = state.pendingTurn !== "" && Date.now() - state.changedAt >= TURN_SETTLE_MS;
  if (!hasSettled) {
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

const watchDevinExport = (exportFile: string): Effect.Effect<never> =>
  Effect.gen(function* () {
    const firstTurn = readTurn(exportFile);
    const watch = yield* Ref.make<WatchState>({ spokenTurn: firstTurn.turnId, pendingTurn: "", changedAt: Date.now() });
    const poll = Ref.update(watch, (state) => pollTurn(exportFile, state));
    return yield* poll.pipe(Effect.zipLeft(pollPause), Effect.forever);
  });

// The watcher stops with the session however it ends, a Devin that never started included.
export const watchDevinSession = <Value, Failure>(request: {
  readonly exportFile: string;
  readonly session: Effect.Effect<Value, Failure>;
}): Effect.Effect<Value, Failure> =>
  Effect.gen(function* () {
    const watcher = yield* watchDevinExport(request.exportFile).pipe(Effect.fork);
    const stopWatcher = Fiber.interrupt(watcher);
    return yield* request.session.pipe(Effect.zipLeft(exitGrace), Effect.ensuring(stopWatcher));
  });
