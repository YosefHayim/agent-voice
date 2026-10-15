/** `voxkey reply`: the agent Stop hook. Queue the finished reply for speech and wake the workers; never fail. */

import { readFileSync } from "node:fs";

import { Effect, Option, Schema } from "effect";

import { readConfigOrDefaults } from "../settings/configFile.js";
import { queueReply, type ReplyOrigin } from "../speech/inbox.js";
import { isWorkerRunning, spawnWorker, startSpeechWorker } from "../workers/workerProcesses.js";
import { type AgentId, agentIdSchema } from "./agentCatalog.js";
import {
  agentReplyIdOf,
  directReply,
  isFinishedTurn,
  replyFromTranscript,
  stopHookInputSchema,
  transcriptPathOf,
} from "./agentReply.js";

const optionalVariable = Schema.optionalWith(Schema.Trim, { default: () => "" });

const cmuxEnvironmentSchema = Schema.Struct({
  CMUX_WORKSPACE_ID: optionalVariable,
  CMUX_SURFACE_ID: optionalVariable,
  CMUX_SOCKET_PATH: optionalVariable,
});

/** A reply from inside Cmux is bound to its workspace and surface; only the socket path is kept, never a capability. */
export const replyOrigin = (): ReplyOrigin => {
  const cmux = Schema.decodeUnknownSync(cmuxEnvironmentSchema)(process.env);
  if (cmux.CMUX_WORKSPACE_ID === "" || cmux.CMUX_SURFACE_ID === "") {
    return { kind: "terminal" };
  }

  return {
    kind: "cmux",
    socketPath: cmux.CMUX_SOCKET_PATH || "/tmp/cmux.sock",
    workspaceId: cmux.CMUX_WORKSPACE_ID,
    surfaceId: cmux.CMUX_SURFACE_ID,
  };
};

const readStandardInput = Effect.tryPromise(async () => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
});

const decodeHookInput = Schema.decodeUnknownOption(Schema.parseJson(stopHookInputSchema));

const transcriptReply = (transcriptPath: string): string =>
  transcriptPath === "" ? "" : replyFromTranscript(readFileSync(transcriptPath, "utf8").split("\n"));

// After a reboot the hook is what brings dictation and speech back.
const wakeWorkers = (): void => {
  if (isWorkerRunning("dictation")) {
    startSpeechWorker();
    return;
  }

  spawnWorker("dictation");
};

const queueAgentReply = (agent: AgentId) =>
  Effect.gen(function* () {
    const config = yield* readConfigOrDefaults;
    if (config.speechMode === "off") {
      return;
    }

    const input = decodeHookInput(yield* readStandardInput);
    if (Option.isNone(input) || !isFinishedTurn(input.value, agent)) {
      return;
    }

    const markdown = directReply(input.value) || transcriptReply(transcriptPathOf(input.value));
    if (markdown.trim() === "") {
      return;
    }

    // A muted reply is dropped here, but the workers still wake, so dictation comes back after a reboot.
    if (!config.speechMuted) {
      queueReply({ markdown, source: agent, agentReplyId: agentReplyIdOf(input.value), origin: replyOrigin() });
    }
    wakeWorkers();
  });

/** The reply hook prints nothing and succeeds whatever happens, so it can never block or confuse the agent. */
export const runReplyHook = (agent: AgentId): Effect.Effect<void> =>
  queueAgentReply(agent).pipe(Effect.catchAllCause(() => Effect.void));

/** The agent named by `--agent <id>` or `--agent=<id>`; none when it is missing or not an agent voxkey knows. */
export const agentFromArguments = (args: ReadonlyArray<string>): Option.Option<AgentId> => {
  const inline = args.find((argument) => argument.startsWith("--agent="));
  if (inline !== undefined) {
    return Schema.decodeUnknownOption(agentIdSchema)(inline.slice("--agent=".length));
  }

  const flagIndex = args.indexOf("--agent");
  return flagIndex < 0 ? Option.none() : Schema.decodeUnknownOption(agentIdSchema)(args[flagIndex + 1]);
};

/**
 * The hook from its raw arguments. A Claude Code Stop hook that exits 2 blocks the agent, so wrong, missing,
 * or extra arguments (say, an agent ID renamed after the hook was registered) are a silent no-op.
 */
export const runReplyHookFromArguments = (args: ReadonlyArray<string>): Effect.Effect<void> =>
  Option.match(agentFromArguments(args), { onNone: () => Effect.void, onSome: runReplyHook });
