import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMacOS, makeTestFolder } from "../scripts/testFolder.js";
import { holdLock, removeFreeLock } from "./fileLock.js";

let folder = "";

beforeEach(() => {
  folder = makeTestFolder("lock");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("file lock", () => {
  it.skipIf(!isMacOS)(
    "is refused to a second taker, even in the same process, until the holder's scope ends",
    async () => {
      const lock = path.join(folder, "model.bin.lock");
      const takers = await Effect.gen(function* () {
        const first = yield* holdLock(lock);
        const second = yield* holdLock(lock).pipe(Effect.scoped);
        return [first, second];
      }).pipe(Effect.scoped, Effect.runPromise);

      expect(takers).toEqual([true, false]);
      expect(existsSync(lock)).toBe(false);
      const isTakenAfterRelease = await holdLock(lock).pipe(Effect.scoped, Effect.runPromise);
      expect(isTakenAfterRelease).toBe(true);
    },
  );

  it.skipIf(!isMacOS)("removes a lock file nobody holds, but never one that is held", async () => {
    const lock = path.join(folder, "dictation.lock");
    writeFileSync(lock, "");
    removeFreeLock(lock);
    expect(existsSync(lock)).toBe(false);

    const keptWhileHeld = await Effect.gen(function* () {
      yield* holdLock(lock);
      removeFreeLock(lock);
      return existsSync(lock);
    }).pipe(Effect.scoped, Effect.runPromise);
    expect(keptWhileHeld).toBe(true);
  });
});
