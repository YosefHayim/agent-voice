import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { holdLock, removeFreeLock } from "./fileLock.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let folder = "";

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  folder = mkdtempSync(path.join(scratchRoot, "lock-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("file lock", () => {
  it("is refused to a second taker, even in the same process, until the holder's scope ends", async () => {
    const lock = path.join(folder, "model.bin.lock");
    const takers = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* holdLock(lock);
          const second = yield* Effect.scoped(holdLock(lock));
          return [first, second];
        }),
      ),
    );

    expect(takers).toEqual([true, false]);
    expect(existsSync(lock)).toBe(false);
    expect(await Effect.runPromise(Effect.scoped(holdLock(lock)))).toBe(true);
  });

  it("removes a lock file nobody holds, but never one that is held", async () => {
    const lock = path.join(folder, "dictation.lock");
    writeFileSync(lock, "");
    removeFreeLock(lock);
    expect(existsSync(lock)).toBe(false);

    const keptWhileHeld = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* holdLock(lock);
          removeFreeLock(lock);
          return existsSync(lock);
        }),
      ),
    );
    expect(keptWhileHeld).toBe(true);
  });
});
