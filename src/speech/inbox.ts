import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import { stateFile, stateFolder } from "#src/settings/agent-voice-home.js";
import type { Config } from "#src/settings/config-schema.js";
import { makePrivateFolder, readJsonFile, removeIfPresent, writeJsonAtomically } from "#src/storage/state-files.js";
import { type CmuxFocus, cmuxFocus } from "./cmux-focus.js";

const terminalOriginSchema = z.object({ kind: z.literal("terminal") });

const cmuxOriginSchema = z.object({
  kind: z.literal("cmux"),
  // Cmux control socket that can say which surface is focused.
  socketPath: z.string(),
  workspaceId: z.string(),
  surfaceId: z.string(),
});

const replyOriginSchema = z.union([terminalOriginSchema, cmuxOriginSchema]);

export type ReplyOrigin = z.infer<typeof replyOriginSchema>;

const queuedReplySchema = z.object({
  // Complete agent reply as Markdown.
  markdown: z.string(),
  // Where the agent ran: a plain terminal or a Cmux surface.
  origin: replyOriginSchema,
  // Unix time in seconds.
  receivedAt: z.number(),
  // The agent's reply or turn ID, else the content token.
  agentReplyId: z.string(),
  // Agent ID that produced the reply.
  source: z.string(),
});

export type QueuedReply = z.infer<typeof queuedReplySchema>;

const seenKeysSchema = z.record(z.string(), z.number());

const nowSeconds = () => Date.now() / 1_000;

const inboxFolder = () => stateFolder("inbox");

const seenFile = () => stateFile("seen.json");

// FNV-1a 64-bit plus the byte length, so the same text gets the same token in every process.
export const contentToken = (markdown: string): string => {
  const bytes = Buffer.from(markdown, "utf8");
  const hash = bytes.reduce((current, byte) => {
    const mixed = (current ^ BigInt(byte)) * 0x100000001b3n;
    return BigInt.asUintN(64, mixed);
  }, 0xcbf29ce484222325n);
  const hexHash = hash.toString(16).padStart(16, "0");
  return `${hexHash}:${bytes.length}`;
};

export const surfaceIdentity = (reply: QueuedReply): string => {
  if (reply.origin.kind !== "cmux" || reply.origin.workspaceId === "" || reply.origin.surfaceId === "") {
    return "";
  }

  return `${reply.origin.workspaceId}:${reply.origin.surfaceId}`;
};

const replyPlace = (reply: QueuedReply): string => {
  const agentId = reply.source || "unknown";
  const surface = surfaceIdentity(reply) || "terminal";
  return `${agentId}:${surface}`;
};

// The same text from the same place is one reply, whatever its ID.
export const contentIdentity = (reply: QueuedReply): string => {
  const place = replyPlace(reply);
  const token = contentToken(reply.markdown);
  return `${place}:${token}`;
};

// Hooks do not always send a stable ID, so the text is always part of the identity.
export const replyIdentity = (reply: QueuedReply): string => {
  const replyId = reply.agentReplyId.trim();
  if (replyId === "") {
    return contentIdentity(reply);
  }

  const place = replyPlace(reply);
  const token = contentToken(reply.markdown);
  return `${place}:${replyId}:${token}`;
};

// When Cmux cannot be asked, speak instead of holding the reply forever.
export const speaksForFocus = (surface: string, focus: CmuxFocus): boolean => {
  switch (focus.kind) {
    case "surface":
      return focus.surface === surface;
    case "away":
      return false;
    case "unknown":
      return true;
  }
};

const inboxFiles = (extension: ".json" | ".speaking"): ReadonlyArray<string> => {
  const folder = inboxFolder();
  if (!existsSync(folder)) {
    return [];
  }

  return readdirSync(folder)
    .filter((name) => name.endsWith(extension) && !name.startsWith("."))
    .sort()
    .map((name) => path.join(folder, name));
};

export const removeInboxFiles = (extensions: ReadonlyArray<".json" | ".speaking">): void => {
  const files = extensions.flatMap(inboxFiles);
  for (const file of files) {
    removeIfPresent(file);
  }
};

// A claimed reply exists only while the speech worker is speaking it.
export const isSpeaking = (): boolean => inboxFiles(".speaking").length > 0;

const seenKeys = (): ReadonlyMap<string, number> => {
  const now = nowSeconds();
  const savedStamps = readJsonFile({ path: seenFile(), schema: seenKeysSchema });
  const isThereNoSavedStamp = savedStamps === null;
  if (isThereNoSavedStamp) {
    return new Map();
  }

  const seenTtlSeconds = 24 * 60 * 60;
  const freshStamps = Object.entries(savedStamps).filter(([, stamp]) => now - stamp <= seenTtlSeconds);
  return new Map(freshStamps);
};

const alreadySpoken = (seen: ReadonlyMap<string, number>, reply: QueuedReply): boolean => {
  const replyKey = replyIdentity(reply);
  const contentKey = contentIdentity(reply);
  return seen.has(replyKey) || seen.has(contentKey);
};

// Both keys, so a later hook with a different reply ID cannot re-speak the same text.
const rememberSpoken = (reply: QueuedReply): void => {
  const now = nowSeconds();
  const replyKey = replyIdentity(reply);
  const contentKey = contentIdentity(reply);
  const previous = seenKeys();
  const seen = new Map(previous).set(replyKey, now).set(contentKey, now);
  const stamps = Object.fromEntries(seen);
  writeJsonAtomically({ path: seenFile(), value: stamps });
};

export const queueReply = (request: {
  readonly markdown: string;
  readonly source: string;
  readonly agentReplyId: string;
  readonly origin: ReplyOrigin;
}): void => {
  const reply: QueuedReply = {
    markdown: request.markdown,
    origin: request.origin,
    receivedAt: nowSeconds(),
    agentReplyId: request.agentReplyId.trim() || contentToken(request.markdown),
    source: request.source,
  };
  const seen = seenKeys();
  if (alreadySpoken(seen, reply)) {
    return;
  }

  // Agent replies are the user's text: the inbox and failed/ are 0700, and each reply file 0600.
  const folder = inboxFolder();
  makePrivateFolder(folder);
  // Wall-clock milliseconds order replies across processes; the high-resolution counter orders them within one.
  const milliseconds = Date.now().toString().padStart(15, "0");
  const counter = process.hrtime.bigint().toString().padStart(20, "0");
  const replyFile = path.join(folder, `${milliseconds}-${counter}-${randomUUID()}.json`);
  writeJsonAtomically({ path: replyFile, value: reply });
};

interface PendingReply {
  readonly file: string;
  readonly reply: QueuedReply;
}

const isSpeakable = (reply: QueuedReply): boolean => {
  const ageSeconds = nowSeconds() - reply.receivedAt;
  const pendingTtlSeconds = 60 * 60;
  const isExpired = reply.receivedAt > 0 && ageSeconds > pendingTtlSeconds;
  return reply.markdown.trim() !== "" && !isExpired;
};

// Oldest first; an unreadable, empty, or expired file is deleted.
const pendingReplies = (): ReadonlyArray<PendingReply> => {
  const files = inboxFiles(".json");
  return files.flatMap((file) => {
    const storedReply = readJsonFile({ path: file, schema: queuedReplySchema });
    const isThereNoReply = storedReply === null || !isSpeakable(storedReply);
    if (isThereNoReply) {
      removeIfPresent(file);
      return [];
    }

    return [{ file, reply: storedReply }];
  });
};

// Newer replies with the same identity, or from the same Cmux surface, supersede older ones.
const isSuperseded = (pending: ReadonlyArray<PendingReply>, candidate: PendingReply): boolean => {
  const identity = replyIdentity(candidate.reply);
  const surface = surfaceIdentity(candidate.reply);
  const newestFirst = [...pending].reverse();
  const newestTwin = newestFirst.find((other) => replyIdentity(other.reply) === identity);
  const hasNewerTwin = newestTwin?.file !== candidate.file;
  if (hasNewerTwin) {
    return true;
  }

  const isTerminalReply = surface === "";
  if (isTerminalReply) {
    return false;
  }

  const newestFromSurface = newestFirst.find((other) => surfaceIdentity(other.reply) === surface);
  return newestFromSurface?.file !== candidate.file;
};

const speaksNow = async (request: {
  readonly mode: Config["speechMode"];
  readonly reply: QueuedReply;
}): Promise<boolean> => {
  const { origin } = request.reply;
  const surface = surfaceIdentity(request.reply);
  const isSpokenAtOnce = request.mode === "immediate" || surface === "" || origin.kind !== "cmux";
  if (isSpokenAtOnce) {
    return true;
  }

  const focus = await cmuxFocus(origin.socketPath);
  return speaksForFocus(surface, focus);
};

// Another process may have claimed or deleted the file since it was listed.
const claimFile = (file: string): string | null => {
  const claimed = file.replace(/\.json$/u, ".speaking");
  try {
    renameSync(file, claimed);
    return claimed;
  } catch {
    return null;
  }
};

// The rename to `.speaking` stops a reply from being picked twice; one waiting for its Cmux surface stays queued.
export const claimNextReply = async (mode: Config["speechMode"]): Promise<PendingReply | null> => {
  const pending = pendingReplies();
  const isModeOff = mode === "off";
  if (isModeOff) {
    removeInboxFiles([".json"]);
    return null;
  }

  const seen = seenKeys();
  for (const candidate of pending) {
    const isStale = isSuperseded(pending, candidate) || alreadySpoken(seen, candidate.reply);
    if (isStale) {
      removeIfPresent(candidate.file);
      continue;
    }

    const isTimeToSpeak = await speaksNow({ mode, reply: candidate.reply });
    if (!isTimeToSpeak) {
      continue;
    }

    const claimed = claimFile(candidate.file);
    const isClaimLost = claimed === null;
    if (isClaimLost) {
      continue;
    }

    // Mark it seen before playback, so a restart during speech never replays it.
    rememberSpoken(candidate.reply);
    return { file: claimed, reply: candidate.reply };
  }

  return null;
};

export const completeReply = (claimedFile: string): void => removeIfPresent(claimedFile);

export const failReply = (claimedFile: string): void => {
  const failedFolder = stateFolder("failed");
  makePrivateFolder(failedFolder);
  const fileName = path.basename(claimedFile);
  const failedFile = path.join(failedFolder, fileName);
  renameSync(claimedFile, failedFile);
};
