import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { waitForLock } from "./file-lock.js";

type DownloadRequest = {
  readonly url: string;
  readonly destination: string;
  readonly onProgress: (receivedBytes: number) => void;
};

const progressStepBytes = 20_000_000;

// A callback that throws errors the stream, which fails the copy as a network error would, so the `.partial` file
// is still removed.
const readProgressCounter = (onProgress: (receivedBytes: number) => void): TransformStream<Uint8Array, Uint8Array> => {
  let received = 0;
  let reported = 0;
  return new TransformStream({
    transform: (chunk, controller) => {
      received += chunk.length;

      const isProgressDue = received - reported >= progressStepBytes;
      if (isProgressDue) {
        reported = received;
        onProgress(received);
      }

      controller.enqueue(chunk);
    },
    flush: () => onProgress(received),
  });
};

const fetchIntoPlace = async (request: DownloadRequest): Promise<void> => {
  const partial = `${request.destination}.partial`;
  const reply = await fetch(request.url, { redirect: "follow" });

  const isReplyFailed = !reply.ok || reply.body === null;
  if (isReplyFailed) {
    throw new Error(`HTTP ${String(reply.status)}`);
  }

  try {
    const counter = readProgressCounter(request.onProgress);
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
const readFileIdentity = (filePath: string): string => {
  const stats = statSync(filePath, { throwIfNoEntry: false });

  const isStatsMissing = stats === undefined;
  if (isStatsMissing) {
    return "";
  }

  return `${String(stats.dev)}:${String(stats.ino)}`;
};

const describeIssue = (error: unknown): string => {
  const isErrorInstanceError = error instanceof Error;
  if (isErrorInstanceError) {
    return error.message;
  }

  return String(error);
};

const downloadFileUnderLock = async (request: DownloadRequest): Promise<void> => {
  const lockPath = `${request.destination}.lock`;
  mkdirSync(path.dirname(request.destination), { recursive: true });
  const before = readFileIdentity(request.destination);
  const releaseLock = await waitForLock(lockPath);
  try {
    const current = readFileIdentity(request.destination);

    const isFinishedByAnother = current !== "" && current !== before;
    if (isFinishedByAnother) {
      return;
    }

    await fetchIntoPlace(request);
  } finally {
    releaseLock();
  }
};

// One download of a file runs at a time across processes: a second caller waits on `<file>.lock`, then reuses the
// file the first one renamed into place. A crashed holder's lock ends with its process, and the next holder
// overwrites its `.partial` file.
export const downloadFile = async (request: DownloadRequest): Promise<void> => {
  try {
    await downloadFileUnderLock(request);
  } catch (error) {
    throw new Error(`Could not download ${request.url}: ${describeIssue(error)}`, { cause: error });
  }
};
