/** Which Cmux surface is in front of the user, asked over the socket a Cmux reply records. */

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

/**
 * One JSON-lines request; the `result` of an `ok` reply, or none when Cmux does not answer, fails, or closes
 * the connection without a reply line (the idle timeout does not fire after the peer has closed).
 */
const askCmux = (request: { readonly socketPath: string; readonly method: string }) =>
  Effect.async<Option.Option<unknown>>((resume) => {
    const socket = createConnection(request.socketPath);
    let received = "";
    let answered = false;
    const finish = (answer: Option.Option<unknown>) => {
      if (answered) {
        return;
      }

      answered = true;
      socket.destroy();
      resume(Effect.succeed(answer));
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish(Option.none()));
    socket.on("error", () => finish(Option.none()));
    socket.on("close", () => finish(Option.none()));
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id: "voxkey", method: request.method, params: {} })}\n`),
    );
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const newline = received.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const reply = Schema.decodeUnknownOption(rpcReplySchema)(received.slice(0, newline));
      finish(Option.flatMap(reply, (answer) => (answer.ok ? Option.some(answer.result) : Option.none())));
    });
    return Effect.sync(() => socket.destroy());
  });

/** A Cmux window is `key` only while Cmux is the frontmost app. */
export const focusFrom = (windows: unknown, identity: unknown): CmuxFocus => {
  const windowList = Schema.decodeUnknownOption(windowListSchema)(windows);
  const focused = Option.flatMap(Schema.decodeUnknownOption(identitySchema)(identity), (decoded) =>
    Option.fromNullable(decoded.focused),
  );
  const frontmost = Option.exists(windowList, (list) => list.windows.some((window) => window.key === true));
  const workspace = Option.getOrElse(
    Option.flatMapNullable(focused, (ids) => ids.workspace_id),
    () => "",
  );
  const surface = Option.getOrElse(
    Option.flatMapNullable(focused, (ids) => ids.surface_id),
    () => "",
  );
  return frontmost && workspace !== "" && surface !== ""
    ? { kind: "surface", surface: `${workspace}:${surface}` }
    : { kind: "away" };
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
