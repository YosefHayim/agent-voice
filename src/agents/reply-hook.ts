import { existsSync, readFileSync } from "node:fs";
import { text } from "node:stream/consumers";

import { readSettingsFileReading } from "#src/settings/config-file.js";
import { defaultSettings, type Settings } from "#src/settings/config-schema.js";
import { queueReply, type ReplyOrigin } from "#src/speech/inbox.js";
import { isWorkerRunning, spawnWorker, startSpeechWorker } from "#src/workers/worker-processes.js";
import { type AgentId, agentIdSchema } from "./agent-catalog.js";
import { readStopReply, replyFromTranscript } from "./agent-reply.js";

const AGENT_FLAG_PREFIX = "--agent=";

const OFF_MODE = "off";

const DICTATION_WORKER_NAME = "dictation";

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
const wakeWorkers = (settings: Settings): void => {
  const isNotWorkerRunningDictation = !isWorkerRunning(DICTATION_WORKER_NAME);
  if (isNotWorkerRunningDictation) {
    spawnWorker(DICTATION_WORKER_NAME);
    return;
  }

  const isSpeechOn = settings.speechMode !== OFF_MODE;
  if (isSpeechOn) {
    startSpeechWorker();
  }
};

const queueAgentReply = async (agent: AgentId): Promise<void> => {
  const hookStdin = await text(process.stdin);
  const stopReply = readStopReply(hookStdin);

  const isThereNoStopReply = stopReply == null;
  if (isThereNoStopReply) {
    return;
  }

  const settingsFileReading = readSettingsFileReading();
  const isSettingsFileBroken = settingsFileReading.status === "broken";
  // A broken file reads as the defaults, and the hook says nothing about it, since its stderr shows to the user.
  const settings = isSettingsFileBroken ? defaultSettings : settingsFileReading.config;
  // Every finished turn wakes dictation, so it comes back after a reboot even with speech off or muted.
  wakeWorkers(settings);

  const isSpeechSilent = settings.speechMode === OFF_MODE || settings.speechMuted;
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

const readAgentFromArguments = (argumentList: ReadonlyArray<string>): AgentId | null => {
  const inlineFlag = argumentList.find((argument) => argument.startsWith(AGENT_FLAG_PREFIX));

  const hasInlineFlag = inlineFlag != null;
  if (hasInlineFlag) {
    const agentName = inlineFlag.slice(AGENT_FLAG_PREFIX.length);
    return parseAgentId(agentName);
  }

  const flagIndex = argumentList.indexOf("--agent");

  const isFlagNotGiven = flagIndex < 0;
  if (isFlagNotGiven) {
    return null;
  }

  return parseAgentId(argumentList[flagIndex + 1]);
};

// A Claude Code Stop hook that exits 2 blocks the agent, so wrong, missing, or extra arguments
// (say, an agent ID renamed after the hook was registered) are a silent no-op.
export const runReplyHookFromArguments = async (argumentList: ReadonlyArray<string>): Promise<void> => {
  const agent = readAgentFromArguments(argumentList);

  const isThereNoAgent = agent == null;
  if (isThereNoAgent) {
    return;
  }

  await runReplyHook(agent);
};
