/**
 * Download one model file over HTTPS to `<file>.partial`, then rename it into place. One download of a file runs at
 * a time across processes: a second caller waits on `<file>.lock`, then reuses the file the first one finished.
 */

import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

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

/**
 * Counts the bytes on their way to the file and reports them every PROGRESS_STEP_BYTES and once at the end. A
 * callback that throws errors the stream, which fails the copy as a network error would, so the `.partial` file is
 * still removed.
 */
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

/** Fetch into `<destination>.partial`, then rename it into place; a failed copy removes the `.partial` file. */
const fetchIntoPlace = async (request: DownloadRequest & { readonly signal: AbortSignal }): Promise<void> => {
  const partial = `${request.destination}.partial`;
  const reply = await fetch(request.url, { signal: request.signal, redirect: "follow" });
  if (!reply.ok || reply.body === null) {
    throw new Error(`HTTP ${String(reply.status)}`);
  }

  try {
    const counted = reply.body.pipeThrough(progressCounter(request.onProgress));
    // pipeline listens for errors on every stream before data flows, so a file that cannot be opened or written
    // rejects here instead of raising an unhandled stream error. The web stream type from fetch and
    // node:stream/web describe the same object (external type).
    await pipeline(Readable.fromWeb(counted as ReadableStream<Uint8Array>), createWriteStream(partial));
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, request.destination);
};

/** Which file is at the path now (device and inode), or "" when none is. */
const fileIdentity = (filePath: string): string => {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  return stats === undefined ? "" : `${String(stats.dev)}:${String(stats.ino)}`;
};

/**
 * Download unless another process does: the `.partial` file is written by one lock holder at a time, a crashed
 * holder's lock ends with its process (and the next holder overwrites its `.partial`), and a caller that waited
 * reuses the file the holder renamed into place instead of downloading it again.
 */
export const downloadFile = (request: DownloadRequest): Effect.Effect<void, ModelDownloadError> => {
  const failed = (error: unknown) =>
    new ModelDownloadError({ url: request.url, issue: error instanceof Error ? error.message : String(error) });
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => mkdirSync(path.dirname(request.destination), { recursive: true }),
        catch: failed,
      });
      const before = yield* Effect.try({ try: () => fileIdentity(request.destination), catch: failed });
      yield* Effect.mapError(waitForLock(`${request.destination}.lock`), failed);
      const current = yield* Effect.try({ try: () => fileIdentity(request.destination), catch: failed });
      if (current !== "" && current !== before) {
        return;
      }

      yield* Effect.tryPromise({ try: (signal) => fetchIntoPlace({ ...request, signal }), catch: failed });
    }),
  );
};
