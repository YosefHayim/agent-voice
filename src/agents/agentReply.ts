/** The complete agent reply a Stop hook should read aloud: from the hook input, else from the transcript. */

import { Option, Schema } from "effect";

import type { AgentId } from "./agentCatalog.js";

const optionalField = Schema.optional(Schema.Unknown);

// Agents spell the same fields differently; every one is decoded here once.
export const stopHookInputSchema = Schema.Struct({
  last_assistant_message: optionalField,
  lastAssistantMessage: optionalField,
  last_agent_message: optionalField,
  lastAgentMessage: optionalField,
  transcript_path: optionalField,
  transcriptPath: optionalField,
  response_id: optionalField,
  responseId: optionalField,
  turn_id: optionalField,
  turnId: optionalField,
  reason: optionalField,
  hook_reason: optionalField,
  hookReason: optionalField,
});

export type StopHookInput = Schema.Schema.Type<typeof stopHookInputSchema>;

const textOf = (value: unknown): string => Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(value), () => "");

const firstText = (values: ReadonlyArray<unknown>): string => values.map(textOf).find((text) => text !== "") || "";

export const directReply = (input: StopHookInput): string =>
  firstText([
    input.last_assistant_message,
    input.lastAssistantMessage,
    input.last_agent_message,
    input.lastAgentMessage,
  ]);

export const transcriptPathOf = (input: StopHookInput): string =>
  firstText([input.transcript_path, input.transcriptPath]);

export const agentReplyIdOf = (input: StopHookInput): string =>
  firstText([input.response_id, input.responseId, input.turn_id, input.turnId]);

/** Grok fires its hook on several events; only a finished turn is read aloud. */
export const isFinishedTurn = (input: StopHookInput, agent: AgentId): boolean => {
  const reason = firstText([input.reason, input.hook_reason, input.hookReason]);
  return (
    agent !== "grok" ||
    reason === "" ||
    ["complete", "completed", "end_turn", "stop"].includes(reason) ||
    reason.endsWith(":end_turn")
  );
};

const transcriptLineSchema = Schema.parseJson(
  Schema.Struct({
    type: optionalField,
    role: optionalField,
    message: optionalField,
    content: optionalField,
  }),
);

const messageSchema = Schema.Struct({ role: optionalField, content: optionalField });

const blockSchema = Schema.Struct({ type: optionalField, text: optionalField });

type TranscriptEntry = { readonly speaker: string; readonly content: unknown };

/** Claude Code writes `type` and wraps the message; other agents write only `role` and `content`. */
const decodeTranscriptLine = (line: string): Option.Option<TranscriptEntry> =>
  Option.map(Schema.decodeUnknownOption(transcriptLineSchema)(line.trim()), (entry) => {
    const message = Schema.decodeUnknownOption(messageSchema)(entry.message);
    return {
      speaker:
        textOf(entry.type) ||
        textOf(entry.role) ||
        Option.getOrElse(
          Option.map(message, (decoded) => textOf(decoded.role)),
          () => "",
        ),
      content: Option.match(message, { onNone: () => entry.content, onSome: (decoded) => decoded.content }),
    };
  });

const contentBlocks = (content: unknown): ReadonlyArray<Schema.Schema.Type<typeof blockSchema>> =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Array(blockSchema))(content), () => []);

const isPlainText = (content: unknown) => Option.isSome(Schema.decodeUnknownOption(Schema.String)(content));

/** A prompt the user typed, not a tool result the agent fed back as a user turn. */
const isGenuineUserPrompt = (entry: TranscriptEntry): boolean =>
  entry.speaker === "user" &&
  (isPlainText(entry.content) ||
    Option.exists(Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(entry.content), () =>
      contentBlocks(entry.content).every((block) => textOf(block.type) !== "tool_result"),
    ));

const assistantTexts = (entry: TranscriptEntry): ReadonlyArray<string> => {
  if (entry.speaker !== "assistant") {
    return [];
  }

  if (isPlainText(entry.content)) {
    return textOf(entry.content).trim() === "" ? [] : [textOf(entry.content)];
  }

  return contentBlocks(entry.content)
    .filter((block) => textOf(block.type) === "text" && textOf(block.text).trim() !== "")
    .map((block) => textOf(block.text));
};

/** Every assistant text block after the latest genuine user prompt, joined as one reply. */
export const replyFromTranscript = (lines: ReadonlyArray<string>): string => {
  const entries = lines.flatMap((line) => Option.toArray(decodeTranscriptLine(line)));
  const lastPrompt = entries.flatMap((entry, index) => (isGenuineUserPrompt(entry) ? [index] : [])).at(-1);
  return entries
    .slice(lastPrompt === undefined ? 0 : lastPrompt + 1)
    .flatMap(assistantTexts)
    .join("\n\n");
};
