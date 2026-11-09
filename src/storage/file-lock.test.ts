import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMacOS, makeTestFolder } from "#src/testing/test-folder.js";
import { holdLock, removeFreeLock } from "./file-lock.js";

let folder = "";

beforeEach(() => {
  folder = makeTestFolder("lock");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("file lock", () => {
  it.skipIf(!isMacOS)("is refused to a second taker, even in the same process, until the holder releases", () => {
    const lock = path.join(folder, "model.bin.lock");

    const releaseFirstTaker = holdLock(lock);
    const releaseSecondTaker = holdLock(lock);

    expect(releaseFirstTaker).not.toBeNull();
    expect(releaseSecondTaker).toBeNull();
    releaseFirstTaker?.();
    expect(existsSync(lock)).toBe(false);
    const releaseAfterRelease = holdLock(lock);
    expect(releaseAfterRelease).not.toBeNull();
    releaseAfterRelease?.();
  });

  it.skipIf(!isMacOS)("removes a lock file nobody holds, but never one that is held", () => {
    const lock = path.join(folder, "dictation.lock");
    writeFileSync(lock, "");
    removeFreeLock(lock);
    expect(existsSync(lock)).toBe(false);

    const releaseHeldLock = holdLock(lock);
    removeFreeLock(lock);

    expect(existsSync(lock)).toBe(true);
    releaseHeldLock?.();
  });
});
