import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { focusFrom } from "./cmuxFocus.js";
import {
  claimNextReply,
  completeReply,
  contentIdentity,
  contentToken,
  failReply,
  isSpeaking,
  type QueuedReply,
  queueReply,
  replyIdentity,
  speaksForFocus,
  surfaceIdentity,
} from "./inbox.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "inbox-"));
  vi.stubEnv("VOXKEY_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const reply = (agentReplyId: string): QueuedReply => ({
  markdown: "Same reply",
  origin: { kind: "terminal" },
  receivedAt: 0,
  agentReplyId,
  source: "claude-code",
});

const cmuxOrigin = (surfaceId: string) =>
  ({ kind: "cmux", socketPath: path.join(home, "no-cmux.sock"), workspaceId: "W1", surfaceId }) as const;

const claim = (mode: "auto" | "immediate" | "off" = "auto") => Effect.runPromise(claimNextReply(mode));

const inboxNames = () => (existsSync(path.join(home, "inbox")) ? readdirSync(path.join(home, "inbox")) : []);

describe("reply identity", () => {
  it("gives the same text the same stable token", () => {
    expect(contentToken("hello world")).toBe(contentToken("hello world"));
    expect(contentToken("hello world")).not.toBe(contentToken("hello world!"));
    expect(contentToken("hello world")).toMatch(/^[0-9a-f]{16}:11$/u);
  });

  it("splits identity by reply ID but shares one content key", () => {
    const plain = reply("");
    const withId = reply("different-id");
    expect(replyIdentity(plain)).not.toBe(replyIdentity(withId));
    expect(contentIdentity(plain)).toBe(contentIdentity(withId));
    expect(replyIdentity(plain)).toBe(contentIdentity(plain));
    expect(replyIdentity(withId)).toBe(`claude-code:terminal:different-id:${contentToken("Same reply")}`);
  });

  it("keys a Cmux reply by workspace and surface", () => {
    expect(surfaceIdentity({ ...reply(""), origin: cmuxOrigin("S1") })).toBe("W1:S1");
    expect(surfaceIdentity(reply(""))).toBe("");
  });
});

describe("Cmux focus", () => {
  it("speaks a held reply only while its surface is focused and Cmux is in front", () => {
    expect(speaksForFocus("W1:S1", { kind: "surface", surface: "W1:S1" })).toBe(true);
    expect(speaksForFocus("W1:S1", { kind: "surface", surface: "W1:S2" })).toBe(false);
    expect(speaksForFocus("W1:S1", { kind: "away" })).toBe(false);
    expect(speaksForFocus("W1:S1", { kind: "unknown" })).toBe(true);
  });

  it("counts a focused surface only while a Cmux window is key", () => {
    const identity = { focused: { workspace_id: "W1", surface_id: "S1" } };
    expect(focusFrom({ windows: [{ key: false }, { key: true }] }, identity)).toEqual({
      kind: "surface",
      surface: "W1:S1",
    });
    expect(focusFrom({ windows: [{ key: false }] }, identity)).toEqual({ kind: "away" });
    expect(focusFrom({ windows: [{ key: true }] }, { focused: null })).toEqual({ kind: "away" });
  });
});

describe("inbox", () => {
  it("claims replies oldest first, marks them speaking, and completes them", async () => {
    queueReply({ markdown: "first", source: "codex", agentReplyId: "a", origin: { kind: "terminal" } });
    queueReply({ markdown: "second", source: "codex", agentReplyId: "b", origin: { kind: "terminal" } });

    const first = Option.getOrThrow(await claim());
    expect(first.reply.markdown).toBe("first");
    expect(isSpeaking()).toBe(true);
    completeReply(first.file);
    expect(Option.getOrThrow(await claim()).reply.markdown).toBe("second");
  });

  it("never speaks the same reply twice, even when the hook fires again with another ID", async () => {
    queueReply({ markdown: "once", source: "codex", agentReplyId: "", origin: { kind: "terminal" } });
    completeReply(Option.getOrThrow(await claim()).file);

    queueReply({ markdown: "once", source: "codex", agentReplyId: "turn-9", origin: { kind: "terminal" } });
    expect(inboxNames()).toEqual([]);
    expect(Option.isNone(await claim())).toBe(true);
  });

  it("lets the newest reply from a Cmux surface supersede older ones, and speaks it when Cmux cannot be asked", async () => {
    queueReply({ markdown: "older", source: "codex", agentReplyId: "1", origin: cmuxOrigin("S1") });
    queueReply({ markdown: "newer", source: "codex", agentReplyId: "2", origin: cmuxOrigin("S1") });

    expect(Option.getOrThrow(await claim()).reply.markdown).toBe("newer");
    expect(inboxNames().filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("empties the queue when speech is off", async () => {
    queueReply({ markdown: "missed while off", source: "grok", agentReplyId: "", origin: { kind: "terminal" } });
    expect(Option.isNone(await claim("off"))).toBe(true);
    expect(inboxNames()).toEqual([]);
  });

  it("deletes unreadable and expired files and moves a failed reply aside", async () => {
    mkdirSync(path.join(home, "inbox"), { recursive: true });
    writeFileSync(path.join(home, "inbox", "0-broken.json"), "{");
    writeFileSync(
      path.join(home, "inbox", "1-old.json"),
      JSON.stringify({ ...reply("x"), markdown: "stale", receivedAt: 1 }),
    );
    queueReply({ markdown: "fresh", source: "codex", agentReplyId: "", origin: { kind: "terminal" } });

    const claimed = Option.getOrThrow(await claim());
    expect(claimed.reply.markdown).toBe("fresh");
    failReply(claimed.file);
    expect(inboxNames()).toEqual([]);
    expect(readdirSync(path.join(home, "failed"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(home, "seen.json"), "utf8"))).toBeTruthy();
  });

  it("keeps queued and failed replies readable by the user alone, tightening an inbox made looser before", async () => {
    const permissions = (file: string) => statSync(file).mode & 0o777;
    mkdirSync(path.join(home, "inbox"));
    chmodSync(path.join(home, "inbox"), 0o755);

    queueReply({ markdown: "the agent's reply", source: "codex", agentReplyId: "", origin: { kind: "terminal" } });
    expect(permissions(path.join(home, "inbox"))).toBe(0o700);
    expect(inboxNames().map((name) => permissions(path.join(home, "inbox", name)))).toEqual([0o600]);

    failReply(Option.getOrThrow(await claim()).file);
    const failed = path.join(home, "failed");
    expect(permissions(failed)).toBe(0o700);
    expect(readdirSync(failed).map((name) => permissions(path.join(failed, name)))).toEqual([0o600]);
  });
});
