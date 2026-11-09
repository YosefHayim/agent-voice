import { Option, Schema } from "effect";

const textOrEmpty = Schema.optionalWith(Schema.String, { nullable: true, default: () => "" });

// Grok writes its own camelCase envelope: https://docs.x.ai/build/features/hooks.md
// Its transcriptPath is Grok's updates.jsonl, not a chat transcript, so it is never read.
const grokStopInput = Schema.Struct({
  hookEventName: Schema.String,
  reason: textOrEmpty,
  lastAssistantMessage: textOrEmpty,
});

// Claude Code, Codex, and Devin: https://code.claude.com/docs/en/hooks and https://developers.openai.com/codex/hooks
const snakeCaseStopInput = Schema.Struct({
  last_assistant_message: textOrEmpty,
  transcript_path: textOrEmpty,
  turn_id: textOrEmpty,
});

const decodeGrokStop = Schema.decodeUnknownOption(Schema.parseJson(grokStopInput));

const decodeSnakeCaseStop = Schema.decodeUnknownOption(Schema.parseJson(snakeCaseStopInput));

type StopReply = { readonly markdown: string; readonly transcriptPath: string; readonly agentReplyId: string };

// Grok also sends Stop when its session closes (reason "shutdown" or "channel_closed"); only a finished turn is read.
const grokTurnReply = (input: typeof grokStopInput.Type): Option.Option<StopReply> => {
  if (input.reason !== "end_turn") {
    return Option.none();
  }

  return Option.some({ markdown: input.lastAssistantMessage, transcriptPath: "", agentReplyId: "" });
};

export const stopReplyFromJson = (json: string): Option.Option<StopReply> => {
  const grokStop = decodeGrokStop(json);
  if (Option.isSome(grokStop)) {
    return grokTurnReply(grokStop.value);
  }

  const snakeCaseStop = decodeSnakeCaseStop(json);
  return Option.map(snakeCaseStop, (input) => ({
    markdown: input.last_assistant_message,
    transcriptPath: input.transcript_path,
    agentReplyId: input.turn_id,
  }));
};

const contentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalWith(Schema.String, { default: () => "" }),
});

const chatMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Union(Schema.String, Schema.Array(contentBlock)),
});

type ChatMessage = typeof chatMessage.Type;

// Claude Code wraps each message as `{ type, message }`; other transcripts write the message itself.
const decodeClaudeLine = Schema.decodeUnknownOption(Schema.parseJson(Schema.Struct({ message: chatMessage })));

const decodeChatLine = Schema.decodeUnknownOption(Schema.parseJson(chatMessage));

const isText = Schema.is(Schema.String);

const transcriptMessage = (line: string): ReadonlyArray<ChatMessage> => {
  const claudeLine = decodeClaudeLine(line);
  if (Option.isSome(claudeLine)) {
    return [claudeLine.value.message];
  }

  const chatLine = decodeChatLine(line);
  return Option.toArray(chatLine);
};

const contentBlocks = (message: ChatMessage): ReadonlyArray<typeof contentBlock.Type> => {
  if (isText(message.content)) {
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
  if (message.role !== "assistant") {
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
