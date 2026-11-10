import { z } from "zod";

const TEXT_BLOCK_TYPE = "text";

interface StopReply {
  readonly markdown: string;
  readonly transcriptPath: string;
  readonly agentReplyId: string;
}

const stringOrEmpty = z
  .string()
  .nullish()
  .transform((string) => string ?? "");

// Grok writes its own camelCase envelope: https://docs.x.ai/build/features/hooks.md
// Its transcriptPath is Grok's updates.jsonl, not a chat transcript, so it is never read.
const grokStopSchema = z.object({
  hookEventName: z.string(),
  reason: stringOrEmpty,
  lastAssistantMessage: stringOrEmpty,
});

type GrokStop = z.infer<typeof grokStopSchema>;

// Claude Code, Codex, and Devin: https://code.claude.com/docs/en/hooks and https://developers.openai.com/codex/hooks
const snakeCaseStopSchema = z.object({
  last_assistant_message: stringOrEmpty,
  transcript_path: stringOrEmpty,
  turn_id: stringOrEmpty,
});

const parseDocumentOrNull = (stopHookStdin: string): unknown => {
  try {
    return JSON.parse(stopHookStdin);
  } catch {
    return null;
  }
};

// Grok also sends Stop when its session closes (reason "shutdown" or "channel_closed"); only a finished turn is read.
const readGrokTurnReply = (grokStop: GrokStop): StopReply | null => {
  const isNotFinishedTurn = grokStop.reason !== "end_turn";
  if (isNotFinishedTurn) {
    return null;
  }

  return { markdown: grokStop.lastAssistantMessage, transcriptPath: "", agentReplyId: "" };
};

export const readStopReply = (stopHookStdin: string): StopReply | null => {
  const stopHookField = parseDocumentOrNull(stopHookStdin);
  const grokStopReply = grokStopSchema.safeParse(stopHookField);

  const isGrokStop = grokStopReply.success;
  if (isGrokStop) {
    return readGrokTurnReply(grokStopReply.data);
  }

  const snakeCaseStopReply = snakeCaseStopSchema.safeParse(stopHookField);

  const isNotSnakeCaseStop = !snakeCaseStopReply.success;
  if (isNotSnakeCaseStop) {
    return null;
  }

  return {
    markdown: snakeCaseStopReply.data.last_assistant_message,
    transcriptPath: snakeCaseStopReply.data.transcript_path,
    agentReplyId: snakeCaseStopReply.data.turn_id,
  };
};

const messageBlockSchema = z.object({
  type: z.string(),
  text: z.string().default(""),
});

type MessageBlock = z.infer<typeof messageBlockSchema>;

const chatMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(messageBlockSchema)]),
});

type ChatMessage = z.infer<typeof chatMessageSchema>;

// Claude Code wraps each message as `{ type, message }`; other transcripts write the message itself.
const claudeLineSchema = z.object({ message: chatMessageSchema });

const listTranscriptMessage = (line: string): ReadonlyArray<ChatMessage> => {
  const lineField = parseDocumentOrNull(line);
  const claudeLine = claudeLineSchema.safeParse(lineField);

  const isClaudeLine = claudeLine.success;
  if (isClaudeLine) {
    return [claudeLine.data.message];
  }

  const chatLine = chatMessageSchema.safeParse(lineField);
  const isChatLine = chatLine.success;
  return isChatLine ? [chatLine.data] : [];
};

const listMessageBlocks = (message: ChatMessage): ReadonlyArray<MessageBlock> => {
  const isPlainMessage = typeof message.content === "string";
  if (isPlainMessage) {
    return [{ type: TEXT_BLOCK_TYPE, text: message.content }];
  }

  return message.content;
};

// Claude Code feeds tool results back as user messages; only a prompt the user typed starts a new reply.
const isUserPrompt = (message: ChatMessage): boolean => {
  const blocks = listMessageBlocks(message);
  return message.role === "user" && blocks.every((block) => block.type !== "tool_result");
};

const listAssistantReplies = (message: ChatMessage): ReadonlyArray<string> => {
  const isMessageRoleNotAssistant = message.role !== "assistant";
  if (isMessageRoleNotAssistant) {
    return [];
  }

  const blocks = listMessageBlocks(message);
  return blocks
    .filter((block) => block.type === TEXT_BLOCK_TYPE && block.text.trim() !== "")
    .map((block) => block.text);
};

export const replyFromTranscript = (transcript: string): string => {
  const lines = transcript.split("\n");
  const messages = lines.flatMap(listTranscriptMessage);
  const promptFlags = messages.map(isUserPrompt);
  const lastPromptIndex = promptFlags.lastIndexOf(true);
  const replyMessages = messages.slice(lastPromptIndex + 1);
  return replyMessages.flatMap(listAssistantReplies).join("\n\n");
};
