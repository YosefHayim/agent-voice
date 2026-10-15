/**
 * Exclusive file locks held by the kernel. macOS takes the lock inside open(2) itself (`O_EXLOCK`) and drops it when
 * the holder closes the file or exits, crash and SIGKILL included, so a lock is never stale: nothing has to judge an
 * old owner dead or take a lock over, which is where file-existence locks let two processes win.
 */

import { closeSync, constants, existsSync, fstatSync, openSync, rmSync, statSync } from "node:fs";

import { Duration, Effect, Option, Schema, type Scope } from "effect";

export class FileLockError extends Schema.TaggedError<FileLockError>()("FileLockError", {
  path: Schema.String,
  issue: Schema.String,
}) {
  get message(): string {
    return `Could not lock ${this.path}: ${this.issue}`;
  }
}

// <sys/fcntl.h> on macOS; Node does not export it. With O_NONBLOCK, open fails with EAGAIN while another holds it.
const O_EXLOCK = 0x20;

const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK;

const LOCK_POLL_MS = 250;

const isHeldElsewhere = Schema.is(Schema.Struct({ code: Schema.Literal("EAGAIN") }));

/** The locked descriptor, or none while another open file (in any process, this one included) holds the lock. */
const openLocked = (filePath: string): Option.Option<number> => {
  try {
    return Option.some(openSync(filePath, LOCK_FLAGS, 0o600));
  } catch (error) {
    if (isHeldElsewhere(error)) {
      return Option.none();
    }

    throw error;
  }
};

const isFileAtPath = (lock: { readonly descriptor: number; readonly filePath: string }): boolean => {
  const locked = fstatSync(lock.descriptor);
  const current = statSync(lock.filePath, { throwIfNoEntry: false });
  return current !== undefined && current.ino === locked.ino && current.dev === locked.dev;
};

/**
 * Take the lock now, or none while it is held. A holder deletes the file just before letting go, so a lock that
 * landed on that deleted file guards nothing: it is dropped and taken again on the file now at the path.
 */
const takeLock = (filePath: string): Option.Option<number> => {
  let locked = openLocked(filePath);
  while (Option.isSome(locked) && !isFileAtPath({ descriptor: locked.value, filePath })) {
    closeSync(locked.value);
    locked = openLocked(filePath);
  }
  return locked;
};

// Deleted while still locked, so a waiter can only lock the file a later holder creates (see takeLock).
const dropLock = (lock: { readonly descriptor: number; readonly filePath: string }): void => {
  rmSync(lock.filePath, { force: true });
  closeSync(lock.descriptor);
};

/**
 * Hold the lock on `filePath` (its folder must exist) for the rest of the scope: true once held, false while another
 * holder has it. Taking the lock and registering its release cannot be split by an interruption.
 */
export const holdLock = (filePath: string): Effect.Effect<boolean, FileLockError, Scope.Scope> =>
  Effect.uninterruptible(
    Effect.flatMap(
      Effect.try({
        try: () => takeLock(filePath),
        catch: (error) => new FileLockError({ path: filePath, issue: String(error) }),
      }),
      Option.match({
        onNone: () => Effect.succeed(false),
        onSome: (descriptor) =>
          Effect.as(
            Effect.addFinalizer(() => Effect.sync(() => dropLock({ descriptor, filePath }))),
            true,
          ),
      }),
    ),
  );

/** Wait until the lock on `filePath` is free, then hold it for the rest of the scope. */
export const waitForLock = (filePath: string): Effect.Effect<void, FileLockError, Scope.Scope> =>
  Effect.gen(function* () {
    while (!(yield* holdLock(filePath))) {
      yield* Effect.sleep(Duration.millis(LOCK_POLL_MS));
    }
  });

/** Delete the lock file unless someone holds it (a held lock is left alone, since deleting it would free it). */
export const removeFreeLock = (filePath: string): void => {
  if (!existsSync(filePath)) {
    return;
  }

  Option.map(takeLock(filePath), (descriptor) => dropLock({ descriptor, filePath }));
};
