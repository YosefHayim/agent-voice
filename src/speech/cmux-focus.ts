import { createConnection } from "node:net";

import { z } from "zod";

export type CmuxFocus =
  | { readonly kind: "surface"; readonly surface: string }
  | { readonly kind: "away" }
  | { readonly kind: "unknown" };

// The answer to one Cmux socket request. Null means Cmux gave no answer at all.
interface CmuxReply {
  readonly result: unknown;
}

const rpcReplySchema = z.object({ ok: z.boolean(), result: z.unknown().optional() });

const windowListSchema = z.object({
  windows: z.array(z.object({ key: z.boolean().optional() })),
});

const identitySchema = z.object({
  focused: z
    .object({
      workspace_id: z.string().optional(),
      surface_id: z.string().optional(),
    })
    .nullable(),
});

// A line that is not JSON is no answer, the same as a socket that closed before replying.
const parseRpcReply = (line: string): z.infer<typeof rpcReplySchema> | null => {
  try {
    const replyJson: unknown = JSON.parse(line);
    const checkedReply = rpcReplySchema.safeParse(replyJson);

    const isReplyInvalid = !checkedReply.success;
    if (isReplyInvalid) {
      return null;
    }

    return checkedReply.data;
  } catch {
    return null;
  }
};

const answerFrom = (line: string): CmuxReply | null => {
  const reply = parseRpcReply(line);

  const isNotOkReply = reply?.ok !== true;
  if (isNotOkReply) {
    return null;
  }

  return { result: reply.result };
};

// A close without a reply line must also finish: the idle timeout never fires after the peer has closed.
const askCmux = (request: { readonly socketPath: string; readonly method: string }): Promise<CmuxReply | null> =>
  new Promise((complete) => {
    const socketTimeoutMilliseconds = 500;
    const socket = createConnection(request.socketPath);
    let received = "";
    let answered = false;
    const finish = (reply: CmuxReply | null) => {
      if (answered) {
        return;
      }

      answered = true;
      socket.destroy();
      complete(reply);
    };

    const giveUp = () => finish(null);

    socket.setTimeout(socketTimeoutMilliseconds, giveUp);
    socket.on("error", giveUp);
    socket.on("close", giveUp);
    socket.on("connect", () => {
      const requestLine = JSON.stringify({ id: "agent-voice", method: request.method, params: {} });
      socket.write(`${requestLine}\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");

      const newline = received.indexOf("\n");

      const isNewlineNotFound = newline < 0;
      if (isNewlineNotFound) {
        return;
      }

      const replyLine = received.slice(0, newline);
      finish(answerFrom(replyLine));
    });
  });

const isWindowKey = (windows: unknown): boolean => {
  const checkedWindows = windowListSchema.safeParse(windows);

  const isWindowsInvalid = !checkedWindows.success;
  if (isWindowsInvalid) {
    return false;
  }

  return checkedWindows.data.windows.some((window) => window.key === true);
};

const readFocusedIdsFrom = (identity: unknown): z.infer<typeof identitySchema>["focused"] => {
  const checkedIdentity = identitySchema.safeParse(identity);

  const isIdentityInvalid = !checkedIdentity.success;
  if (isIdentityInvalid) {
    return null;
  }

  return checkedIdentity.data.focused;
};

// A Cmux window is `key` only while Cmux is the frontmost app.
export const focusFrom = (windows: unknown, identity: unknown): CmuxFocus => {
  const isFrontmost = isWindowKey(windows);
  const focused = readFocusedIdsFrom(identity);
  const workspace = focused?.workspace_id ?? "";
  const surface = focused?.surface_id ?? "";

  const isNotFocusedSurface = !isFrontmost || workspace === "" || surface === "";
  if (isNotFocusedSurface) {
    return { kind: "away" };
  }

  return { kind: "surface", surface: `${workspace}:${surface}` };
};

export const readCmuxFocus = async (socketPath: string): Promise<CmuxFocus> => {
  const windowsReply = await askCmux({ socketPath, method: "window.list" });
  const identityReply = await askCmux({ socketPath, method: "system.identify" });

  const isThereNoAnswer = windowsReply === null || identityReply === null;
  if (isThereNoAnswer) {
    return { kind: "unknown" };
  }

  return focusFrom(windowsReply.result, identityReply.result);
};
