import { createConnection } from "node:net";

import { Effect, Option, Schema } from "effect";

export type CmuxFocus =
  | { readonly kind: "surface"; readonly surface: string }
  | { readonly kind: "away" }
  | { readonly kind: "unknown" };

const rpcReplySchema = Schema.parseJson(Schema.Struct({ ok: Schema.Boolean, result: Schema.optional(Schema.Unknown) }));

const windowListSchema = Schema.Struct({
  windows: Schema.Array(Schema.Struct({ key: Schema.optional(Schema.Boolean) })),
});

const identitySchema = Schema.Struct({
  focused: Schema.NullOr(
    Schema.Struct({
      workspace_id: Schema.optional(Schema.String),
      surface_id: Schema.optional(Schema.String),
    }),
  ),
});

const SOCKET_TIMEOUT_MS = 500;

const answerFrom = (line: string): Option.Option<unknown> => {
  const reply = Schema.decodeUnknownOption(rpcReplySchema)(line);
  return reply.pipe(
    Option.filter((answer) => answer.ok),
    Option.map((answer) => answer.result),
  );
};

// A close without a reply line must also finish: the idle timeout never fires after the peer has closed.
const askCmux = (request: { readonly socketPath: string; readonly method: string }) =>
  Effect.async<Option.Option<unknown>>((resume) => {
    const socket = createConnection(request.socketPath);
    const noAnswer = Option.none();
    let received = "";
    let answered = false;
    const finish = (answer: Option.Option<unknown>) => {
      if (answered) {
        return;
      }

      answered = true;
      socket.destroy();
      const answerEffect = Effect.succeed(answer);
      resume(answerEffect);
    };

    const giveUp = () => finish(noAnswer);

    socket.setTimeout(SOCKET_TIMEOUT_MS, giveUp);
    socket.on("error", giveUp);
    socket.on("close", giveUp);
    socket.on("connect", () => {
      const requestLine = JSON.stringify({ id: "agent-voice", method: request.method, params: {} });
      socket.write(`${requestLine}\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const newline = received.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const replyLine = received.slice(0, newline);
      const answer = answerFrom(replyLine);
      finish(answer);
    });
    return Effect.sync(() => socket.destroy());
  });

// A Cmux window is `key` only while Cmux is the frontmost app.
export const focusFrom = (windows: unknown, identity: unknown): CmuxFocus => {
  const windowList = Schema.decodeUnknownOption(windowListSchema)(windows);
  const decodedIdentity = Schema.decodeUnknownOption(identitySchema)(identity);
  const focused = Option.flatMapNullable(decodedIdentity, (decoded) => decoded.focused);
  const isFrontmost = Option.exists(windowList, (list) => list.windows.some((window) => window.key === true));
  const workspace = focused.pipe(
    Option.flatMapNullable((ids) => ids.workspace_id),
    Option.getOrElse(() => ""),
  );
  const surface = focused.pipe(
    Option.flatMapNullable((ids) => ids.surface_id),
    Option.getOrElse(() => ""),
  );
  const isFocusedSurface = isFrontmost && workspace !== "" && surface !== "";
  if (!isFocusedSurface) {
    return { kind: "away" };
  }

  return { kind: "surface", surface: `${workspace}:${surface}` };
};

export const cmuxFocus = (socketPath: string): Effect.Effect<CmuxFocus> =>
  Effect.gen(function* () {
    const windows = yield* askCmux({ socketPath, method: "window.list" });
    const identity = yield* askCmux({ socketPath, method: "system.identify" });
    if (Option.isNone(windows) || Option.isNone(identity)) {
      return { kind: "unknown" };
    }

    return focusFrom(windows.value, identity.value);
  });
