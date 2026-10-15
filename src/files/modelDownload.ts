import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { Effect, Schema } from "effect";

import { waitForLock } from "./fileLock.js";

export class ModelDownloadError extends Schema.TaggedError<ModelDownloadError>()("ModelDownloadError", {
  url: Schema.String,
  issue: Schema.String,
}) {
  get message(): string {
    return `Could not download ${this.url}: ${this.issue}`;
  }
}

type DownloadRequest = {
  readonly url: string;
  readonly destination: string;
  readonly onProgress: (receivedBytes: number) => void;
};

const PROGRESS_STEP_BYTES = 20_000_000;

// A callback that throws errors the stream, which fails the copy as a network error would, so the `.partial` file
// is still removed.
const progressCounter = (onProgress: (receivedBytes: number) => void): TransformStream<Uint8Array, Uint8Array> => {
  let received = 0;
  let reported = 0;
  return new TransformStream({
    transform: (chunk, controller) => {
      received += chunk.length;
      if (received - reported >= PROGRESS_STEP_BYTES) {
        reported = received;
        onProgress(received);
      }
      controller.enqueue(chunk);
    },
    flush: () => onProgress(received),
  });
};

const fetchIntoPlace = async (request: DownloadRequest & { readonly signal: AbortSignal }): Promise<void> => {
  const partial = `${request.destination}.partial`;
  const reply = await fetch(request.url, { signal: request.signal, redirect: "follow" });
  if (!reply.ok || reply.body === null) {
    throw new Error(`HTTP ${String(reply.status)}`);
  }

  try {
    const counter = progressCounter(request.onProgress);
    const counted = reply.body.pipeThrough(counter);
    const file = createWriteStream(partial);
    // pipeline listens for errors on every stream before data flows, so a file that cannot be opened or written
    // rejects here instead of raising an unhandled stream error.
    await pipeline(counted, file);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, request.destination);
};

// Device and inode, so a file renamed into place by another process reads as a different file.
const fileIdentity = (filePath: string): string => {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) {
    return "";
  }

  return `${String(stats.dev)}:${String(stats.ino)}`;
};

const issueOf = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

// One download of a file runs at a time across processes: a second caller waits on `<file>.lock`, then reuses the
// file the first one renamed into place. A crashed holder's lock ends with its process, and the next holder
// overwrites its `.partial` file.
export const downloadFile = (request: DownloadRequest): Effect.Effect<void, ModelDownloadError> => {
  const failed = (error: unknown) => new ModelDownloadError({ url: request.url, issue: issueOf(error) });
  const folder = path.dirname(request.destination);
  const lockPath = `${request.destination}.lock`;
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => mkdirSync(folder, { recursive: true }), catch: failed });
    const before = yield* Effect.try({ try: () => fileIdentity(request.destination), catch: failed });
    yield* waitForLock(lockPath).pipe(Effect.mapError(failed));
    const current = yield* Effect.try({ try: () => fileIdentity(request.destination), catch: failed });
    const isFinishedByAnother = current !== "" && current !== before;
    if (isFinishedByAnother) {
      return;
    }

    yield* Effect.tryPromise({ try: (signal) => fetchIntoPlace({ ...request, signal }), catch: failed });
  }).pipe(Effect.scoped);
};
