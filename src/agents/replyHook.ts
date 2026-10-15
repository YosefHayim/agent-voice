import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";

import { Effect, Option, Schema } from "effect";

import { readConfigOrDefaults } from "../settings/configFile.js";
import { queueReply, type ReplyOrigin } from "../speech/inbox.js";
import { isWorkerRunning, spawnWorker, startSpeechWorker } from "../workers/workerProcesses.js";
import { type AgentId, agentIdSchema } from "./agentCatalog.js";
import { replyFromTranscript, stopReplyFromJson } from "./agentReply.js";

const optionalVariable = Schema.optionalWith(Schema.Trim, { default: () => "" });

const cmuxEnvironmentSchema = Schema.Struct({
  CMUX_WORKSPACE_ID: optionalVariable,
  CMUX_SURFACE_ID: optionalVariable,
  CMUX_SOCKET_PATH: optionalVariable,
});

// Only the socket path is kept, never the socket capability.
const replyOrigin = (): ReplyOrigin => {
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

const readStandardInput = Effect.tryPromise(() => text(process.stdin));

const transcriptReply = (transcriptPath: string): string => {
  if (transcriptPath === "") {
    return "";
  }

  const transcript = readFileSync(transcriptPath, "utf8");
  return replyFromTranscript(transcript);
};

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

    const hookInput = yield* readStandardInput;
    const stopReply = stopReplyFromJson(hookInput);
    if (Option.isNone(stopReply)) {
      return;
    }

    const markdown = stopReply.value.markdown || transcriptReply(stopReply.value.transcriptPath);
    if (markdown.trim() === "") {
      return;
    }

    // A muted reply is dropped here, but the workers still wake, so dictation comes back after a reboot.
    if (!config.speechMuted) {
      const origin = replyOrigin();
      queueReply({ markdown, source: agent, agentReplyId: stopReply.value.agentReplyId, origin });
    }
    wakeWorkers();
  });

// The hook prints nothing and succeeds whatever happens, so it can never block or confuse the agent.
const runReplyHook = (agent: AgentId): Effect.Effect<void> =>
  queueAgentReply(agent).pipe(Effect.catchAllCause(() => Effect.void));

const decodeAgentId = Schema.decodeUnknownOption(agentIdSchema);

const agentFromArguments = (args: ReadonlyArray<string>): Option.Option<AgentId> => {
  const inlineFlag = args.find((argument) => argument.startsWith("--agent="));
  if (inlineFlag !== undefined) {
    const agentName = inlineFlag.slice("--agent=".length);
    return decodeAgentId(agentName);
  }

  const flagIndex = args.indexOf("--agent");
  if (flagIndex < 0) {
    return Option.none();
  }

  return decodeAgentId(args[flagIndex + 1]);
};

// A Claude Code Stop hook that exits 2 blocks the agent, so wrong, missing, or extra arguments
// (say, an agent ID renamed after the hook was registered) are a silent no-op.
export const runReplyHookFromArguments = (args: ReadonlyArray<string>): Effect.Effect<void> => {
  const agent = agentFromArguments(args);
  return Option.match(agent, { onNone: () => Effect.void, onSome: runReplyHook });
};
