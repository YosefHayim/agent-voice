import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readStopReply, replyFromTranscript } from "./agent-reply.js";

const readFixture = (name: string) => {
  const fixtureUrl = new URL(`./fixtures/${name}`, import.meta.url);
  return readFileSync(fixtureUrl, "utf8");
};

const readGrokStop = (reason: string) =>
  JSON.stringify({
    hookEventName: "Stop",
    hook_event_name: "Stop",
    reason,
    lastAssistantMessage: "Complete answer",
    transcriptPath: "/grok/updates.jsonl",
    transcript_path: "/grok/updates.jsonl",
  });

describe("readStopReply", () => {
  it("reads the reply, transcript path, and turn ID that Claude Code, Codex, and Devin send", () => {
    const stopHookStdin = JSON.stringify({
      hook_event_name: "Stop",
      last_assistant_message: "# Done",
      transcript_path: "/x.jsonl",
      turn_id: "t-9",
    });

    expect(readStopReply(stopHookStdin)).toEqual({
      markdown: "# Done",
      transcriptPath: "/x.jsonl",
      agentReplyId: "t-9",
    });
  });

  it("reads a null or missing field as empty", () => {
    const stopHookStdin = JSON.stringify({ last_assistant_message: null, transcript_path: null });

    expect(readStopReply(stopHookStdin)).toEqual({ markdown: "", transcriptPath: "", agentReplyId: "" });
  });

  it("reads a finished Grok turn, never its transcript, and skips a session close", () => {
    const finishedTurn = readGrokStop("end_turn");
    const sessionClose = readGrokStop("shutdown");

    expect(readStopReply(finishedTurn)).toEqual({
      markdown: "Complete answer",
      transcriptPath: "",
      agentReplyId: "",
    });
    expect(readStopReply(sessionClose)).toBeNull();
  });

  it("reads nothing from input that is not a JSON object", () => {
    expect(readStopReply("not json")).toBeNull();
    expect(readStopReply("null")).toBeNull();
  });
});

describe("replyFromTranscript", () => {
  it("joins every assistant text block after the latest user prompt in a Claude transcript", () => {
    const transcript = readFixture("claude-transcript.jsonl");

    expect(replyFromTranscript(transcript)).toBe("First section\n\nSecond section\n\n- complete");
  });

  it("reads role/content transcripts and skips blank assistant text", () => {
    const transcript = readFixture("codex-transcript.jsonl");

    expect(replyFromTranscript(transcript)).toBe("Fixed the build.");
  });
});
