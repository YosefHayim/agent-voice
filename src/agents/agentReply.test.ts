import { readFileSync } from "node:fs";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  agentReplyIdOf,
  directReply,
  isFinishedTurn,
  replyFromTranscript,
  stopHookInputSchema,
  transcriptPathOf,
} from "./agentReply.js";

const fixtureLines = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n");

const input = (fields: Record<string, unknown>) => Schema.decodeUnknownSync(stopHookInputSchema)(fields);

describe("agent reply from a Stop hook", () => {
  it("prefers the reply the agent passes directly, in any of its spellings", () => {
    expect(directReply(input({ last_assistant_message: "# Done" }))).toBe("# Done");
    expect(directReply(input({ lastAssistantMessage: "camel" }))).toBe("camel");
    expect(directReply(input({ last_agent_message: 42, lastAgentMessage: "codex" }))).toBe("codex");
    expect(directReply(input({}))).toBe("");
  });

  it("reads the transcript path and the reply ID", () => {
    const fields = input({ transcriptPath: "/x.jsonl", turn_id: "t-9" });
    expect(transcriptPathOf(fields)).toBe("/x.jsonl");
    expect(agentReplyIdOf(fields)).toBe("t-9");
  });

  it("reads only finished Grok turns and every turn from other agents", () => {
    expect(isFinishedTurn(input({ reason: "end_turn" }), "grok")).toBe(true);
    expect(isFinishedTurn(input({ hookReason: "session:end_turn" }), "grok")).toBe(true);
    expect(isFinishedTurn(input({}), "grok")).toBe(true);
    expect(isFinishedTurn(input({ reason: "tool_use" }), "grok")).toBe(false);
    expect(isFinishedTurn(input({ reason: "tool_use" }), "codex")).toBe(true);
  });

  it("joins every assistant text block after the latest genuine user prompt in a Claude transcript", () => {
    expect(replyFromTranscript(fixtureLines("claudeTranscript.jsonl"))).toBe(
      "First section\n\nSecond section\n\n- complete",
    );
  });

  it("reads role/content transcripts and skips blank assistant text", () => {
    expect(replyFromTranscript(fixtureLines("codexTranscript.jsonl"))).toBe("Fixed the build.");
  });
});
