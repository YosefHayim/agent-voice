import { z } from "zod";

interface StopReply {
  readonly markdown: string;
  readonly transcriptPath: string;
  readonly agentReplyId: string;
}

// A missing or null field reads as empty text.
const textOrEmpty = z
  .string()
  .nullish()
  .transform((text) => text ?? "");

// Grok writes its own camelCase envelope: https://docs.x.ai/build/features/hooks.md
// Its transcriptPath is Grok's updates.jsonl, not a chat transcript, so it is never read.
const grokStopSchema = z.object({
  hookEventName: z.string(),
  reason: textOrEmpty,
  lastAssistantMessage: textOrEmpty,
});

type GrokStop = z.infer<typeof grokStopSchema>;

// Claude Code, Codex, and Devin: https://code.claude.com/docs/en/hooks and https://developers.openai.com/codex/hooks
const snakeCaseStopSchema = z.object({
  last_assistant_message: textOrEmpty,
  transcript_path: textOrEmpty,
  turn_id: textOrEmpty,
});

// Input that is not JSON is simply not a stop reply, so it reads as null.
const parseJsonOrNull = (stopHookStdin: string): unknown => {
  try {
    return JSON.parse(stopHookStdin);
  } catch {
    return null;
  }
};

// Grok also sends Stop when its session closes (reason "shutdown" or "channel_closed"); only a finished turn is read.
const grokTurnReply = (grokStop: GrokStop): StopReply | null => {
  const isNotFinishedTurn = grokStop.reason !== "end_turn";
  if (isNotFinishedTurn) {
    return null;
  }

  return { markdown: grokStop.lastAssistantMessage, transcriptPath: "", agentReplyId: "" };
};

export const readStopReply = (stopHookStdin: string): StopReply | null => {
  const stopHookValue = parseJsonOrNull(stopHookStdin);
  const grokStopReply = grokStopSchema.safeParse(stopHookValue);

  const isGrokStop = grokStopReply.success;
  if (isGrokStop) {
    return grokTurnReply(grokStopReply.data);
  }

  const snakeCaseStopReply = snakeCaseStopSchema.safeParse(stopHookValue);

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

const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().default(""),
});

type ContentBlock = z.infer<typeof contentBlockSchema>;

const chatMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

type ChatMessage = z.infer<typeof chatMessageSchema>;

// Claude Code wraps each message as `{ type, message }`; other transcripts write the message itself.
const claudeLineSchema = z.object({ message: chatMessageSchema });

const transcriptMessage = (line: string): ReadonlyArray<ChatMessage> => {
  const lineValue = parseJsonOrNull(line);
  const claudeLine = claudeLineSchema.safeParse(lineValue);

  const isClaudeLine = claudeLine.success;
  if (isClaudeLine) {
    return [claudeLine.data.message];
  }

  const chatLine = chatMessageSchema.safeParse(lineValue);
  const isChatLine = chatLine.success;
  return isChatLine ? [chatLine.data] : [];
};

const contentBlocks = (message: ChatMessage): ReadonlyArray<ContentBlock> => {
  const isPlainText = typeof message.content === "string";
  if (isPlainText) {
    return [{ type: "text", text: message.content }];
  }

  return message.content;
};

// Claude Code feeds tool results back as user messages; only a prompt the user typed starts a new reply.
const isUserPrompt = (message: ChatMessage): boolean => {
  const blocks = contentBlocks(message);
  return message.role === "user" && blocks.every((block) => block.type !== "tool_result");
};

const assistantTexts = (message: ChatMessage): ReadonlyArray<string> => {
  const isMessageRoleNotAssistant = message.role !== "assistant";
  if (isMessageRoleNotAssistant) {
    return [];
  }

  const blocks = contentBlocks(message);
  return blocks.filter((block) => block.type === "text" && block.text.trim() !== "").map((block) => block.text);
};

export const replyFromTranscript = (transcript: string): string => {
  const lines = transcript.split("\n");
  const messages = lines.flatMap(transcriptMessage);
  const promptFlags = messages.map(isUserPrompt);
  const lastPromptIndex = promptFlags.lastIndexOf(true);
  const replyMessages = messages.slice(lastPromptIndex + 1);
  return replyMessages.flatMap(assistantTexts).join("\n\n");
};
