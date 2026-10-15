import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import type { Config } from "../settings/configSchema.js";
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

let home = "";

beforeEach(() => {
  home = makeTestFolder("inbox");
  vi.stubEnv("AGENT_VOICE_HOME", home);
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

const claimNext = (mode: Config["speechMode"]) => {
  const claiming = claimNextReply(mode);
  return Effect.runPromise(claiming);
};

const claimReply = async () => {
  const claimed = await claimNext("auto");
  return Option.getOrThrow(claimed);
};

const inboxNames = (): ReadonlyArray<string> => {
  const inbox = path.join(home, "inbox");
  if (!existsSync(inbox)) {
    return [];
  }

  return readdirSync(inbox);
};

const permissions = (file: string): number => statSync(file).mode & 0o777;

const filePermissions = (folder: string): ReadonlyArray<number> =>
  readdirSync(folder).map((name) => {
    const file = path.join(folder, name);
    return permissions(file);
  });

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
    const cmuxReply = { ...reply(""), origin: cmuxOrigin("S1") };
    expect(surfaceIdentity(cmuxReply)).toBe("W1:S1");
    const terminalReply = reply("");
    expect(surfaceIdentity(terminalReply)).toBe("");
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

    const first = await claimReply();
    expect(first.reply.markdown).toBe("first");
    expect(isSpeaking()).toBe(true);
    completeReply(first.file);
    const second = await claimReply();
    expect(second.reply.markdown).toBe("second");
  });

  it("never speaks the same reply twice, even when the hook fires again with another ID", async () => {
    queueReply({ markdown: "once", source: "codex", agentReplyId: "", origin: { kind: "terminal" } });
    const spoken = await claimReply();
    completeReply(spoken.file);

    queueReply({ markdown: "once", source: "codex", agentReplyId: "turn-9", origin: { kind: "terminal" } });
    const next = await claimNext("auto");
    expect(inboxNames()).toEqual([]);
    expect(Option.isNone(next)).toBe(true);
  });

  it("lets the newest reply from a Cmux surface supersede older ones, and speaks it when Cmux cannot be asked", async () => {
    queueReply({ markdown: "older", source: "codex", agentReplyId: "1", origin: cmuxOrigin("S1") });
    queueReply({ markdown: "newer", source: "codex", agentReplyId: "2", origin: cmuxOrigin("S1") });

    const claimed = await claimReply();
    expect(claimed.reply.markdown).toBe("newer");
    expect(inboxNames().filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("empties the queue when speech is off", async () => {
    queueReply({ markdown: "missed while off", source: "grok", agentReplyId: "", origin: { kind: "terminal" } });
    const next = await claimNext("off");
    expect(Option.isNone(next)).toBe(true);
    expect(inboxNames()).toEqual([]);
  });

  it("deletes unreadable and expired files and moves a failed reply aside", async () => {
    const inbox = path.join(home, "inbox");
    const brokenFile = path.join(inbox, "0-broken.json");
    const staleFile = path.join(inbox, "1-old.json");
    const staleReply = JSON.stringify({ ...reply("x"), markdown: "stale", receivedAt: 1 });
    mkdirSync(inbox, { recursive: true });
    writeFileSync(brokenFile, "{");
    writeFileSync(staleFile, staleReply);
    queueReply({ markdown: "fresh", source: "codex", agentReplyId: "", origin: { kind: "terminal" } });

    const claimed = await claimReply();
    expect(claimed.reply.markdown).toBe("fresh");
    failReply(claimed.file);
    const failed = path.join(home, "failed");
    const seenFile = path.join(home, "seen.json");
    const seenText = readFileSync(seenFile, "utf8");
    expect(inboxNames()).toEqual([]);
    expect(readdirSync(failed)).toHaveLength(1);
    expect(JSON.parse(seenText)).toBeTruthy();
  });

  it("keeps queued and failed replies readable by the user alone, tightening an inbox made looser before", async () => {
    const inbox = path.join(home, "inbox");
    const failed = path.join(home, "failed");
    mkdirSync(inbox);
    chmodSync(inbox, 0o755);

    queueReply({ markdown: "the agent's reply", source: "codex", agentReplyId: "", origin: { kind: "terminal" } });
    expect(permissions(inbox)).toBe(0o700);
    expect(filePermissions(inbox)).toEqual([0o600]);

    const claimed = await claimReply();
    failReply(claimed.file);
    expect(permissions(failed)).toBe(0o700);
    expect(filePermissions(failed)).toEqual([0o600]);
  });
});
