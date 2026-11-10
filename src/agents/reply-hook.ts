import { existsSync, readFileSync } from "node:fs";
import { text } from "node:stream/consumers";

import { readConfigFileReading } from "#src/settings/config-file.js";
import { type Config, defaultConfig } from "#src/settings/config-schema.js";
import { queueReply, type ReplyOrigin } from "#src/speech/inbox.js";
import { isWorkerRunning, spawnWorker, startSpeechWorker } from "#src/workers/worker-processes.js";
import { type AgentId, agentIdSchema } from "./agent-catalog.js";
import { readStopReply, replyFromTranscript } from "./agent-reply.js";

// Only the socket path is kept, never the socket capability.
const replyOrigin = (): ReplyOrigin => {
  const workspaceId = (process.env.CMUX_WORKSPACE_ID ?? "").trim();
  const surfaceId = (process.env.CMUX_SURFACE_ID ?? "").trim();
  const socketPath = (process.env.CMUX_SOCKET_PATH ?? "").trim();

  const isThereNoCmuxPane = workspaceId === "" || surfaceId === "";
  if (isThereNoCmuxPane) {
    return { kind: "terminal" };
  }

  return {
    kind: "cmux",
    socketPath: socketPath || "/tmp/cmux.sock",
    workspaceId,
    surfaceId,
  };
};

// A missing transcript is an expected outcome: the reply is simply empty, and nothing is printed.
const readTranscriptReply = (transcriptPath: string): string => {
  const isThereNoTranscript = transcriptPath === "" || !existsSync(transcriptPath);
  if (isThereNoTranscript) {
    return "";
  }

  const transcript = readFileSync(transcriptPath, "utf8");
  return replyFromTranscript(transcript);
};

// A new dictation worker starts speech itself when speech is on.
const wakeWorkers = (config: Config): void => {
  const isNotWorkerRunningDictation = !isWorkerRunning("dictation");
  if (isNotWorkerRunningDictation) {
    spawnWorker("dictation");
    return;
  }

  const isSpeechOn = config.speechMode !== "off";
  if (isSpeechOn) {
    startSpeechWorker();
  }
};

const queueAgentReply = async (agent: AgentId): Promise<void> => {
  const hookInput = await text(process.stdin);
  const stopReply = readStopReply(hookInput);

  const isThereNoStopReply = stopReply === null;
  if (isThereNoStopReply) {
    return;
  }

  const configFileReading = readConfigFileReading();
  const isConfigFileBroken = configFileReading.status === "broken";
  // A broken file reads as the defaults, and the hook says nothing about it, since its stderr shows to the user.
  const config = isConfigFileBroken ? defaultConfig : configFileReading.config;
  // Every finished turn wakes dictation, so it comes back after a reboot even with speech off or muted.
  wakeWorkers(config);

  const isSpeechSilent = config.speechMode === "off" || config.speechMuted;
  if (isSpeechSilent) {
    return;
  }

  const markdown = stopReply.markdown || readTranscriptReply(stopReply.transcriptPath);

  const isThereNoMarkdown = markdown.trim() === "";
  if (isThereNoMarkdown) {
    return;
  }

  const origin = replyOrigin();
  queueReply({ markdown, source: agent, agentReplyId: stopReply.agentReplyId, origin });
};

// The hook exits 0 whatever happens, so it can never block or confuse the agent; a failure is only written to stderr.
const runReplyHook = async (agent: AgentId): Promise<void> => {
  try {
    await queueAgentReply(agent);
  } catch (error) {
    console.error({ agent, error });
  }
};

const parseAgentId = (agentName: string | undefined): AgentId | null => {
  const parsedAgent = agentIdSchema.safeParse(agentName);
  return parsedAgent.success ? parsedAgent.data : null;
};

const readAgentFromArguments = (args: ReadonlyArray<string>): AgentId | null => {
  const inlineFlag = args.find((argument) => argument.startsWith("--agent="));

  const hasInlineFlag = inlineFlag !== undefined;
  if (hasInlineFlag) {
    const agentName = inlineFlag.slice("--agent=".length);
    return parseAgentId(agentName);
  }

  const flagIndex = args.indexOf("--agent");

  const isFlagNotGiven = flagIndex < 0;
  if (isFlagNotGiven) {
    return null;
  }

  return parseAgentId(args[flagIndex + 1]);
};

// A Claude Code Stop hook that exits 2 blocks the agent, so wrong, missing, or extra arguments
// (say, an agent ID renamed after the hook was registered) are a silent no-op.
export const runReplyHookFromArguments = async (args: ReadonlyArray<string>): Promise<void> => {
  const agent = readAgentFromArguments(args);

  const isThereNoAgent = agent === null;
  if (isThereNoAgent) {
    return;
  }

  await runReplyHook(agent);
};
