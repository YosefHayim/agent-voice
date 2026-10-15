/**
 * The speech inbox: one JSON file per queued agent reply (written by `voxkey reply` and the Devin
 * watcher), claimed one at a time by the speech worker by renaming it to `.speaking`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

import { Effect, Option, Schema } from "effect";
import { makePrivateFolder, readJsonFile, removeIfPresent, writeJsonAtomically } from "../files/stateFiles.js";
import type { Config } from "../settings/configSchema.js";
import { stateFile, stateFolder } from "../settings/voxkeyHome.js";
import { type CmuxFocus, cmuxFocus } from "./cmuxFocus.js";

const terminalOriginSchema = Schema.Struct({ kind: Schema.Literal("terminal") });

const cmuxOriginSchema = Schema.Struct({
  kind: Schema.Literal("cmux"),
  socketPath: Schema.String.annotations({ description: "Cmux control socket that can say which surface is focused." }),
  workspaceId: Schema.String,
  surfaceId: Schema.String,
});

export const replyOriginSchema = Schema.Union(terminalOriginSchema, cmuxOriginSchema);

export type ReplyOrigin = Schema.Schema.Type<typeof replyOriginSchema>;

export const queuedReplySchema = Schema.Struct({
  markdown: Schema.String.annotations({ description: "Complete agent reply as Markdown." }),
  origin: replyOriginSchema.annotations({ description: "Where the agent ran: a plain terminal or a Cmux surface." }),
  receivedAt: Schema.Number.annotations({ description: "Unix time in seconds." }),
  agentReplyId: Schema.String.annotations({ description: "The agent's reply or turn ID, else the content token." }),
  source: Schema.String.annotations({ description: "Agent ID that produced the reply." }),
});

export type QueuedReply = Schema.Schema.Type<typeof queuedReplySchema>;

const seenKeysSchema = Schema.Record({ key: Schema.String, value: Schema.Number });

const PENDING_TTL_SECONDS = 60 * 60;
const SEEN_TTL_SECONDS = 24 * 60 * 60;

const nowSeconds = () => Date.now() / 1_000;

/** Stable FNV-1a 64-bit over the UTF-8 bytes, plus the byte length: the same text always gets the same token. */
export const contentToken = (markdown: string): string => {
  const bytes = Buffer.from(markdown, "utf8");
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `${hash.toString(16).padStart(16, "0")}:${String(bytes.length)}`;
};

/** `workspace:surface` for a Cmux reply, empty otherwise. */
export const surfaceIdentity = (reply: QueuedReply): string => {
  if (reply.origin.kind !== "cmux" || reply.origin.workspaceId === "" || reply.origin.surfaceId === "") {
    return "";
  }

  return `${reply.origin.workspaceId}:${reply.origin.surfaceId}`;
};

const replyPlace = (reply: QueuedReply): string =>
  `${reply.source || "unknown"}:${surfaceIdentity(reply) || "terminal"}`;

/** The same text from the same place is one reply, whatever its ID. */
export const contentIdentity = (reply: QueuedReply): string => `${replyPlace(reply)}:${contentToken(reply.markdown)}`;

/** Content-based, so a reply is never spoken twice even when hooks fire without a stable ID; the ID refines it. */
export const replyIdentity = (reply: QueuedReply): string => {
  const replyId = reply.agentReplyId.trim();
  return replyId === "" ? contentIdentity(reply) : `${replyPlace(reply)}:${replyId}:${contentToken(reply.markdown)}`;
};

/** `immediate` speaks at once; `auto` holds a Cmux reply until its surface is in front, unless Cmux cannot be asked. */
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

const inboxFolder = () => stateFolder("inbox");

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
  for (const file of extensions.flatMap(inboxFiles)) {
    removeIfPresent(file);
  }
};

/** A claimed reply exists while the speech worker is speaking it. */
export const isSpeaking = (): boolean => inboxFiles(".speaking").length > 0;

const seenKeys = (): ReadonlyMap<string, number> => {
  const now = nowSeconds();
  const saved = Option.getOrElse(readJsonFile({ path: stateFile("seen.json"), schema: seenKeysSchema }), () => ({}));
  return new Map(Object.entries(saved).filter(([, stamp]) => now - stamp <= SEEN_TTL_SECONDS));
};

const alreadySpoken = (seen: ReadonlyMap<string, number>, reply: QueuedReply): boolean =>
  seen.has(replyIdentity(reply)) || seen.has(contentIdentity(reply));

// Both keys, so a later hook with a different reply ID cannot re-speak the same text.
const rememberSpoken = (reply: QueuedReply): void => {
  const now = nowSeconds();
  const seen = new Map(seenKeys()).set(replyIdentity(reply), now).set(contentIdentity(reply), now);
  writeJsonAtomically({ path: stateFile("seen.json"), value: Object.fromEntries(seen) });
};

/** Queue one agent reply; a reply already spoken is dropped before it ever reaches the speaker. */
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
  if (alreadySpoken(seenKeys(), reply)) {
    return;
  }

  // Agent replies are the user's text: the inbox and failed/ are 0700, and each reply file 0600.
  makePrivateFolder(inboxFolder());
  // Wall-clock milliseconds order replies across processes; the high-resolution counter orders them within one.
  const name = `${String(Date.now()).padStart(15, "0")}-${String(process.hrtime.bigint()).padStart(20, "0")}-${randomUUID()}.json`;
  writeJsonAtomically({ path: path.join(inboxFolder(), name), value: Schema.encodeSync(queuedReplySchema)(reply) });
};

type PendingReply = { readonly file: string; readonly reply: QueuedReply };

const isExpired = (reply: QueuedReply) => reply.receivedAt > 0 && nowSeconds() - reply.receivedAt > PENDING_TTL_SECONDS;

/** Readable, non-empty, unexpired replies, oldest first; anything else is deleted. */
const pendingReplies = (): ReadonlyArray<PendingReply> =>
  inboxFiles(".json").flatMap((file) => {
    const reply = Option.filter(
      readJsonFile({ path: file, schema: queuedReplySchema }),
      (decoded) => decoded.markdown.trim() !== "" && !isExpired(decoded),
    );
    if (Option.isNone(reply)) {
      removeIfPresent(file);
      return [];
    }

    return [{ file, reply: reply.value }];
  });

// Newer replies with the same identity, or from the same Cmux surface, supersede older ones.
const isSuperseded = (pending: ReadonlyArray<PendingReply>, candidate: PendingReply): boolean => {
  const identity = replyIdentity(candidate.reply);
  const surface = surfaceIdentity(candidate.reply);
  const newestFirst = [...pending].reverse();
  const newerTwin = newestFirst.find((other) => replyIdentity(other.reply) === identity);
  const newerFromSurface =
    surface === "" ? candidate : newestFirst.find((other) => surfaceIdentity(other.reply) === surface);
  return newerTwin?.file !== candidate.file || newerFromSurface?.file !== candidate.file;
};

const speaksNow = (request: { readonly mode: Config["speechMode"]; readonly reply: QueuedReply }) => {
  const surface = surfaceIdentity(request.reply);
  if (request.mode === "immediate" || surface === "" || request.reply.origin.kind !== "cmux") {
    return Effect.succeed(true);
  }

  return Effect.map(cmuxFocus(request.reply.origin.socketPath), (focus) => speaksForFocus(surface, focus));
};

// Another process may have claimed or deleted the file since it was listed.
const claimFile = (file: string): string | undefined => {
  const claimed = file.replace(/\.json$/u, ".speaking");
  try {
    renameSync(file, claimed);
    return claimed;
  } catch {
    return undefined;
  }
};

/**
 * Claim the next reply to speak by renaming it to `.speaking`, so it cannot be picked twice. A reply
 * still waiting for its Cmux surface stays queued; with speech off the inbox is emptied.
 */
export const claimNextReply = (mode: Config["speechMode"]): Effect.Effect<Option.Option<PendingReply>> =>
  Effect.gen(function* () {
    const pending = pendingReplies();
    if (mode === "off") {
      removeInboxFiles([".json"]);
      return Option.none();
    }

    const seen = seenKeys();
    for (const candidate of pending) {
      if (isSuperseded(pending, candidate) || alreadySpoken(seen, candidate.reply)) {
        removeIfPresent(candidate.file);
        continue;
      }

      if (!(yield* speaksNow({ mode, reply: candidate.reply }))) {
        continue;
      }

      const claimed = claimFile(candidate.file);
      if (claimed === undefined) {
        continue;
      }

      // Mark it seen before playback, so a restart during speech never replays it.
      rememberSpoken(candidate.reply);
      return Option.some({ file: claimed, reply: candidate.reply });
    }

    return Option.none();
  });

export const completeReply = (claimedFile: string): void => removeIfPresent(claimedFile);

export const failReply = (claimedFile: string): void => {
  const failed = stateFolder("failed");
  makePrivateFolder(failed);
  renameSync(claimedFile, path.join(failed, path.basename(claimedFile)));
};
