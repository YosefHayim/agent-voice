import { closeSync, constants, existsSync, fstatSync, openSync, rmSync, statSync } from "node:fs";

import { Duration, Effect, Option, Schedule, Schema, type Scope } from "effect";

export class FileLockError extends Schema.TaggedError<FileLockError>()("FileLockError", {
  path: Schema.String,
  issue: Schema.String,
}) {
  get message(): string {
    return `Could not lock ${this.path}: ${this.issue}`;
  }
}

// macOS takes the lock inside open(2) and drops it when the holder closes the file or exits, crash and SIGKILL
// included, so a lock is never stale and nothing has to judge an old owner dead.
// <sys/fcntl.h> on macOS; Node does not export it. With O_NONBLOCK, open fails with EAGAIN while another holds it.
const O_EXLOCK = 0x20;

const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK;

const LOCK_POLL = Duration.millis(250);

const isHeldElsewhere = Schema.is(Schema.Struct({ code: Schema.Literal("EAGAIN") }));

type HeldLock = { readonly descriptor: number; readonly filePath: string };

// Another open file holds the lock, in any process, this one included.
const openLocked = (filePath: string): Option.Option<number> => {
  try {
    const descriptor = openSync(filePath, LOCK_FLAGS, 0o600);
    return Option.some(descriptor);
  } catch (error) {
    if (isHeldElsewhere(error)) {
      return Option.none();
    }

    throw error;
  }
};

const isFileAtPath = (lock: HeldLock): boolean => {
  const locked = fstatSync(lock.descriptor);
  const current = statSync(lock.filePath, { throwIfNoEntry: false });
  return current !== undefined && current.ino === locked.ino && current.dev === locked.dev;
};

// A holder deletes the file just before letting go, so a lock that landed on that deleted file guards nothing:
// it is dropped and taken again on the file now at the path.
const takeLock = (filePath: string): Option.Option<number> => {
  const locked = openLocked(filePath);
  if (Option.isNone(locked)) {
    return locked;
  }

  const descriptor = locked.value;
  if (isFileAtPath({ descriptor, filePath })) {
    return locked;
  }

  closeSync(descriptor);
  return takeLock(filePath);
};

// Deleted while still locked, so a waiter can only lock the file a later holder creates (see takeLock).
const dropLock = (lock: HeldLock): void => {
  rmSync(lock.filePath, { force: true });
  closeSync(lock.descriptor);
};

// Taking the lock and registering its release cannot be split by an interruption. The folder must exist.
export const holdLock = (filePath: string): Effect.Effect<boolean, FileLockError, Scope.Scope> =>
  Effect.gen(function* () {
    const locked = yield* Effect.try({
      try: () => takeLock(filePath),
      catch: (error) => new FileLockError({ path: filePath, issue: String(error) }),
    });
    if (Option.isNone(locked)) {
      return false;
    }

    const descriptor = locked.value;
    yield* Effect.addFinalizer(() => Effect.sync(() => dropLock({ descriptor, filePath })));
    return true;
  }).pipe(Effect.uninterruptible);

export const waitForLock = (filePath: string): Effect.Effect<void, FileLockError, Scope.Scope> =>
  holdLock(filePath).pipe(
    Effect.repeat({ schedule: Schedule.spaced(LOCK_POLL), until: (isHeld) => isHeld }),
    Effect.asVoid,
  );

// A held lock is left alone, since deleting its file would free it.
export const removeFreeLock = (filePath: string): void => {
  if (!existsSync(filePath)) {
    return;
  }

  const locked = takeLock(filePath);
  if (Option.isNone(locked)) {
    return;
  }

  dropLock({ descriptor: locked.value, filePath });
};
