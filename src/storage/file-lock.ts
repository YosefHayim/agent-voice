import { closeSync, constants, existsSync, fstatSync, openSync, rmSync, statSync } from "node:fs";

import { isErrorWithCode } from "#src/error-code.js";
import { sleep } from "#src/sleep.js";

// macOS takes the lock inside open(2) and drops it when the holder closes the file or exits, crash and SIGKILL
// included, so a lock is never stale and nothing has to judge an old owner dead.
// <sys/fcntl.h> on macOS; Node does not export it. With O_NONBLOCK, open fails with EAGAIN while another holds it.
const O_EXLOCK = 0x20;

const lockOpenFlags = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK;

const lockPollMilliseconds = 250;

// Releases a lock this process took. Calling it deletes the lock file, then lets go of the lock.
export type ReleaseLock = () => void;

type HeldLock = { readonly descriptor: number; readonly filePath: string };

// Another open file holds the lock, in any process, this one included. Returns null in that case.
const openLocked = (filePath: string): number | null => {
  try {
    const lockFileMode = 0o600;

    return openSync(filePath, lockOpenFlags, lockFileMode);
  } catch (error) {
    const isHeldElsewhere = isErrorWithCode(error, "EAGAIN");
    if (isHeldElsewhere) {
      return null;
    }

    throw error;
  }
};

const isFileAtPath = (lock: HeldLock): boolean => {
  const locked = fstatSync(lock.descriptor);
  const current = statSync(lock.filePath, { throwIfNoEntry: false });
  return current != null && current.ino === locked.ino && current.dev === locked.dev;
};

// A holder deletes the file just before letting go, so a lock that landed on that deleted file guards nothing:
// it is dropped and taken again on the file now at the path.
const takeLock = (filePath: string): number | null => {
  const descriptor = openLocked(filePath);

  const isHeldElsewhere = descriptor == null;
  if (isHeldElsewhere) {
    return null;
  }

  const isOnFileAtPath = isFileAtPath({ descriptor, filePath });
  if (isOnFileAtPath) {
    return descriptor;
  }

  closeSync(descriptor);
  return takeLock(filePath);
};

// Deleted while still locked, so a waiter can only lock the file a later holder creates (see takeLock).
const dropLock = (lock: HeldLock): void => {
  rmSync(lock.filePath, { force: true });
  closeSync(lock.descriptor);
};

const takeLockOrReport = (filePath: string): number | null => {
  try {
    return takeLock(filePath);
  } catch (error) {
    throw new Error(`Could not lock ${filePath}: ${String(error)}`, { cause: error });
  }
};

// Returns the release when this caller took the lock, or null when another holder has it. The folder must exist.
export const holdLock = (filePath: string): ReleaseLock | null => {
  const descriptor = takeLockOrReport(filePath);

  const isHeldElsewhere = descriptor == null;
  if (isHeldElsewhere) {
    return null;
  }

  return () => dropLock({ descriptor, filePath });
};

// Polls until the lock is free, then holds it, so a starter waits its turn instead of failing.
export const waitForLock = async (filePath: string): Promise<ReleaseLock> => {
  const release = holdLock(filePath);

  const isHeld = release != null;
  if (isHeld) {
    return release;
  }

  await sleep(lockPollMilliseconds);
  return waitForLock(filePath);
};

// A held lock is left alone, since deleting its file would free it.
export const removeFreeLock = (filePath: string): void => {
  const isLockFileAbsent = !existsSync(filePath);
  if (isLockFileAbsent) {
    return;
  }

  const descriptor = takeLock(filePath);

  const isHeldElsewhere = descriptor == null;
  if (isHeldElsewhere) {
    return;
  }

  dropLock({ descriptor, filePath });
};
