import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import { readStatusFile, readStatusFolder } from "#src/settings/agent-voice-home.js";
import type { Settings } from "#src/settings/config-schema.js";
import {
  makePrivateFolder,
  readDocumentFile,
  removeFileIfExists,
  writeDocumentAtomically,
} from "#src/storage/state-files.js";
import { type CmuxFocus, readCmuxFocus } from "./cmux-focus.js";

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

const REPLY_FILE_SUFFIX = ".json";

const SPEAKING_FILE_SUFFIX = ".speaking";

const CMUX_TARGET = "cmux";

const TERMINAL_TARGET = "terminal";

const terminalOriginSchema = z.object({ kind: z.literal(TERMINAL_TARGET) });

const cmuxOriginSchema = z.object({
  kind: z.literal(CMUX_TARGET),
  socketPath: z.string(),
  workspaceId: z.string(),
  surfaceId: z.string(),
});

const replyOriginSchema = z.union([terminalOriginSchema, cmuxOriginSchema]);

export type ReplyOrigin = z.infer<typeof replyOriginSchema>;

const queuedReplySchema = z.object({
  markdown: z.string(),
  // Where the agent ran: a plain terminal or a Cmux surface.
  origin: replyOriginSchema,
  // Unix time in seconds.
  receivedAt: z.number(),
  // The agent's reply or turn ID, else the content token.
  agentReplyId: z.string(),
  source: z.string(),
});

export type QueuedReply = z.infer<typeof queuedReplySchema>;

const seenKeysSchema = z.record(z.string(), z.number());

const millisecondsPerSecond = 1_000;

const readNowSeconds = () => Date.now() / millisecondsPerSecond;

const readInboxFolder = () => readStatusFolder("inbox");

const readSeenFile = () => readStatusFile("seen.json");

// FNV-1a 64-bit plus the byte length, so the same text gets the same token in every process.
export const readMessageToken = (markdown: string): string => {
  const bytes = Buffer.from(markdown, "utf8");
  const hash = bytes.reduce((current, byte) => {
    const mixed = (current ^ BigInt(byte)) * 0x100000001b3n;
    const hashBitCount = 64;

    return BigInt.asUintN(hashBitCount, mixed);
  }, 0xcbf29ce484222325n);
  const hexRadix = 16;
  const hexDigitCount = 16;
  const hexHash = hash.toString(hexRadix).padStart(hexDigitCount, "0");
  return `${hexHash}:${bytes.length}`;
};

export const readSurfaceIdentity = (reply: QueuedReply): string => {
  const { origin } = reply;

  const isOriginUnusable = origin.kind !== CMUX_TARGET || origin.workspaceId === "" || origin.surfaceId === "";
  if (isOriginUnusable) {
    return "";
  }

  return `${origin.workspaceId}:${origin.surfaceId}`;
};

const replyPlace = (reply: QueuedReply): string => {
  const agentId = reply.source || "unknown";
  const surface = readSurfaceIdentity(reply) || TERMINAL_TARGET;
  return `${agentId}:${surface}`;
};

// The same text from the same place is one reply, whatever its ID.
export const readMessageIdentity = (reply: QueuedReply): string => {
  const place = replyPlace(reply);
  const token = readMessageToken(reply.markdown);
  return `${place}:${token}`;
};

// Hooks do not always send a stable ID, so the text is always part of the identity.
export const replyIdentity = (reply: QueuedReply): string => {
  const replyId = reply.agentReplyId.trim();

  const isReplyIdEmpty = replyId === "";
  if (isReplyIdEmpty) {
    return readMessageIdentity(reply);
  }

  const place = replyPlace(reply);
  const token = readMessageToken(reply.markdown);
  return `${place}:${replyId}:${token}`;
};

// When Cmux cannot be asked, speak instead of holding the reply forever.
export const isSpeaksForFocus = (surface: string, focus: CmuxFocus): boolean => {
  switch (focus.kind) {
    case "surface":
      return focus.surface === surface;
    case "away":
      return false;
    case "unknown":
      return true;
  }
};

const listInboxFiles = (extension: ".json" | ".speaking"): ReadonlyArray<string> => {
  const folder = readInboxFolder();

  const isFolderAbsent = !existsSync(folder);
  if (isFolderAbsent) {
    return [];
  }

  return readdirSync(folder)
    .filter((name) => name.endsWith(extension) && !name.startsWith("."))
    .sort()
    .map((name) => path.join(folder, name));
};

export const removeInboxFiles = (extensions: ReadonlyArray<".json" | ".speaking">): void => {
  const files = extensions.flatMap(listInboxFiles);
  for (const file of files) {
    removeFileIfExists(file);
  }
};

// A claimed reply exists only while the speech worker is speaking it.
export const isSpeaking = (): boolean => listInboxFiles(SPEAKING_FILE_SUFFIX).length > 0;

const readSeenKeys = (): ReadonlyMap<string, number> => {
  const now = readNowSeconds();
  const seenFilePath = readSeenFile();
  const savedStamps = readDocumentFile({ path: seenFilePath, schema: seenKeysSchema });

  const isThereNoSavedStamp = savedStamps == null;
  if (isThereNoSavedStamp) {
    return new Map();
  }

  const hoursPerDay = 24;
  const seenTtlSeconds = hoursPerDay * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
  const freshStamps = Object.entries(savedStamps).filter(([, stamp]) => now - stamp <= seenTtlSeconds);
  return new Map(freshStamps);
};

const hasBeenSpoken = (seen: ReadonlyMap<string, number>, reply: QueuedReply): boolean => {
  const replyKey = replyIdentity(reply);
  const messageKey = readMessageIdentity(reply);
  return seen.has(replyKey) || seen.has(messageKey);
};

// Both keys, so a later hook with a different reply ID cannot re-speak the same text.
const rememberSpoken = (reply: QueuedReply): void => {
  const now = readNowSeconds();
  const replyKey = replyIdentity(reply);
  const messageKey = readMessageIdentity(reply);
  const previous = readSeenKeys();
  const seen = new Map(previous).set(replyKey, now).set(messageKey, now);
  const stamps = Object.fromEntries(seen);
  const seenFilePath = readSeenFile();

  writeDocumentAtomically({ path: seenFilePath, value: stamps });
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
    receivedAt: readNowSeconds(),
    agentReplyId: request.agentReplyId.trim() || readMessageToken(request.markdown),
    source: request.source,
  };

  const seen = readSeenKeys();

  const isAlreadySpoken = hasBeenSpoken(seen, reply);
  if (isAlreadySpoken) {
    return;
  }

  // Agent replies are the user's text: the inbox and failed/ are 0700, and each reply file 0600.
  const folder = readInboxFolder();
  makePrivateFolder(folder);
  // Wall-clock milliseconds order replies across processes; the high-resolution counter orders them within one.
  const timestampDigits = 15;

  const milliseconds = Date.now().toString().padStart(timestampDigits, "0");
  const counterDigits = 20;

  const counter = process.hrtime.bigint().toString().padStart(counterDigits, "0");
  const replyFile = path.join(folder, `${milliseconds}-${counter}-${randomUUID()}.json`);
  writeDocumentAtomically({ path: replyFile, value: reply });
};

interface PendingReply {
  readonly file: string;
  readonly reply: QueuedReply;
}

const isSpeakable = (reply: QueuedReply): boolean => {
  const ageSeconds = readNowSeconds() - reply.receivedAt;
  const pendingTtlSeconds = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
  const isExpired = reply.receivedAt > 0 && ageSeconds > pendingTtlSeconds;
  return reply.markdown.trim() !== "" && !isExpired;
};

// Oldest first; an unreadable, empty, or expired file is deleted.
const listPendingReplies = (): ReadonlyArray<PendingReply> => {
  const files = listInboxFiles(REPLY_FILE_SUFFIX);
  return files.flatMap((file) => {
    const storedReply = readDocumentFile({ path: file, schema: queuedReplySchema });

    const isThereNoReply = storedReply == null || !isSpeakable(storedReply);
    if (isThereNoReply) {
      removeFileIfExists(file);
      return [];
    }

    return [{ file, reply: storedReply }];
  });
};

// Newer replies with the same identity, or from the same Cmux surface, supersede older ones.
const isSuperseded = (pending: ReadonlyArray<PendingReply>, candidate: PendingReply): boolean => {
  const identity = replyIdentity(candidate.reply);
  const surface = readSurfaceIdentity(candidate.reply);
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

  const newestFromSurface = newestFirst.find((other) => readSurfaceIdentity(other.reply) === surface);
  return newestFromSurface?.file !== candidate.file;
};

const isSpeaksNow = async (request: {
  readonly mode: Settings["speechMode"];
  readonly reply: QueuedReply;
}): Promise<boolean> => {
  const { origin } = request.reply;
  const surface = readSurfaceIdentity(request.reply);

  const isSpokenAtOnce = request.mode === "immediate" || surface === "" || origin.kind !== CMUX_TARGET;
  if (isSpokenAtOnce) {
    return true;
  }

  const focus = await readCmuxFocus(origin.socketPath);
  return isSpeaksForFocus(surface, focus);
};

// Another process may have claimed or deleted the file since it was listed.
const claimFile = (file: string): string | null => {
  const claimed = file.replace(/\.json$/u, SPEAKING_FILE_SUFFIX);

  try {
    renameSync(file, claimed);
    return claimed;
  } catch {
    return null;
  }
};

// The rename to `.speaking` stops a reply from being picked twice; one waiting for its Cmux surface stays queued.
export const claimNextReply = async (mode: Settings["speechMode"]): Promise<PendingReply | null> => {
  const pending = listPendingReplies();

  const isModeOff = mode === "off";
  if (isModeOff) {
    removeInboxFiles([REPLY_FILE_SUFFIX]);
    return null;
  }

  const seen = readSeenKeys();
  for (const candidate of pending) {
    const isStale = isSuperseded(pending, candidate) || hasBeenSpoken(seen, candidate.reply);
    if (isStale) {
      removeFileIfExists(candidate.file);
      continue;
    }

    const isTimeToSpeak = await isSpeaksNow({ mode, reply: candidate.reply });
    const isNotTimeToSpeak = !isTimeToSpeak;
    if (isNotTimeToSpeak) {
      continue;
    }

    const claimed = claimFile(candidate.file);

    const isClaimLost = claimed == null;
    if (isClaimLost) {
      continue;
    }

    // Mark it seen before playback, so a restart during speech never replays it.
    rememberSpoken(candidate.reply);
    return { file: claimed, reply: candidate.reply };
  }

  return null;
};

export const completeReply = (claimedFile: string): void => removeFileIfExists(claimedFile);

export const failReply = (claimedFile: string): void => {
  const failedFolder = readStatusFolder("failed");
  makePrivateFolder(failedFolder);
  const fileName = path.basename(claimedFile);
  const failedFile = path.join(failedFolder, fileName);
  renameSync(claimedFile, failedFile);
};
