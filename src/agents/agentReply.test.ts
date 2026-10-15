import { readFileSync } from "node:fs";

import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { replyFromTranscript, stopReplyFromJson } from "./agentReply.js";

const fixture = (name: string) => {
  const fixtureUrl = new URL(`./fixtures/${name}`, import.meta.url);
  return readFileSync(fixtureUrl, "utf8");
};

const grokStop = (reason: string) =>
  JSON.stringify({
    hookEventName: "Stop",
    hook_event_name: "Stop",
    reason,
    lastAssistantMessage: "Complete answer",
    transcriptPath: "/grok/updates.jsonl",
    transcript_path: "/grok/updates.jsonl",
  });

describe("stopReplyFromJson", () => {
  it("reads the reply, transcript path, and turn ID that Claude Code, Codex, and Devin send", () => {
    const stopInput = JSON.stringify({
      hook_event_name: "Stop",
      last_assistant_message: "# Done",
      transcript_path: "/x.jsonl",
      turn_id: "t-9",
    });

    expect(stopReplyFromJson(stopInput)).toEqual(
      Option.some({ markdown: "# Done", transcriptPath: "/x.jsonl", agentReplyId: "t-9" }),
    );
  });

  it("reads a null or missing field as empty", () => {
    const stopInput = JSON.stringify({ last_assistant_message: null, transcript_path: null });

    expect(stopReplyFromJson(stopInput)).toEqual(Option.some({ markdown: "", transcriptPath: "", agentReplyId: "" }));
  });

  it("reads a finished Grok turn, never its transcript, and skips a session close", () => {
    const finishedTurn = grokStop("end_turn");
    const sessionClose = grokStop("shutdown");

    expect(stopReplyFromJson(finishedTurn)).toEqual(
      Option.some({ markdown: "Complete answer", transcriptPath: "", agentReplyId: "" }),
    );
    expect(stopReplyFromJson(sessionClose)).toEqual(Option.none());
  });

  it("reads nothing from input that is not a JSON object", () => {
    expect(stopReplyFromJson("not json")).toEqual(Option.none());
    expect(stopReplyFromJson("null")).toEqual(Option.none());
  });
});

describe("replyFromTranscript", () => {
  it("joins every assistant text block after the latest user prompt in a Claude transcript", () => {
    const transcript = fixture("claudeTranscript.jsonl");

    expect(replyFromTranscript(transcript)).toBe("First section\n\nSecond section\n\n- complete");
  });

  it("reads role/content transcripts and skips blank assistant text", () => {
    const transcript = fixture("codexTranscript.jsonl");

    expect(replyFromTranscript(transcript)).toBe("Fixed the build.");
  });
});
