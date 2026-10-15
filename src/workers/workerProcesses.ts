/** The two background workers (dictation, speech): pid and lock files, spawning, stopping, and reset. */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Effect, Option, Schema, type Scope } from "effect";
import { type FileLockError, holdLock, removeFreeLock } from "../files/fileLock.js";
import {
  makePrivateFolder,
  openPrivateFile,
  readTextIfReadable,
  removeIfPresent,
  touchFile,
} from "../files/stateFiles.js";
import { stateFile, voxkeyHome } from "../settings/voxkeyHome.js";
import { removeInboxFiles } from "../speech/inbox.js";
import { readWorkerStatus, writeWorkerStatus } from "./workerStatus.js";

export type WorkerKind = "dictation" | "speech";

type PidFileName = "dictation.pid" | "speech.pid" | "pill.pid";

export class WorkerStartError extends Schema.TaggedError<WorkerStartError>()("WorkerStartError", {
  worker: Schema.String,
  logFile: Schema.String,
  lastLines: Schema.String,
}) {
  get message(): string {
    const tail = this.lastLines === "" ? "" : `\n${this.lastLines}`;
    return `The ${this.worker} worker did not start. See ${this.logFile}.${tail}`;
  }
}

const pidFile = (kind: WorkerKind): PidFileName => (kind === "dictation" ? "dictation.pid" : "speech.pid");

const lockFile = (kind: WorkerKind) => (kind === "dictation" ? stateFile("dictation.lock") : stateFile("speech.lock"));

const logFile = (kind: WorkerKind) =>
  kind === "dictation" ? stateFile("dictation-worker.log") : stateFile("speech-worker.log");

export const readPid = (name: PidFileName): Option.Option<number> =>
  Option.filter(
    Option.flatMap(readTextIfReadable(stateFile(name)), (text) =>
      Schema.decodeUnknownOption(Schema.NumberFromString)(text.trim()),
    ),
    (pid) => Number.isInteger(pid) && pid > 1,
  );

export const writePid = (name: PidFileName, pid: number): void => {
  makePrivateFolder(voxkeyHome());
  writeFileSync(stateFile(name), String(pid));
};

// A zombie still answers signal 0 until it is reaped, so it is checked by its ps state.
const isZombie = (pid: number): boolean =>
  spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" })
    .stdout.trim()
    .startsWith("Z");

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
};

const PROCESS_ROW = /^\s*(\S+)\s+(.*)$/u;

// What each pid file stands for. A pid can be reused by another program (say after a reboot), so a pid file is
// trusted, and its pid signalled, only while that pid still runs this command line.
const isNamedProcess = (name: PidFileName, commandLine: string): boolean => {
  switch (name) {
    case "dictation.pid":
      return commandLine.endsWith(" worker dictation");
    case "speech.pid":
      return commandLine.endsWith(" worker speech");
    case "pill.pid":
      return commandLine.includes("osascript -l JavaScript") && commandLine.includes(voxkeyHome());
  }
};

/** The pid in a pid file, while that process is alive (not a zombie) and still the voxkey process the file names. */
export const runningPid = (name: PidFileName): Option.Option<number> =>
  Option.filter(readPid(name), (pid) => {
    const row = PROCESS_ROW.exec(
      spawnSync("ps", ["-o", "state=,args=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(),
    );
    return row !== null && !(row[1] || "").startsWith("Z") && isNamedProcess(name, row[2] || "");
  });

export const isWorkerRunning = (kind: WorkerKind): boolean => Option.isSome(runningPid(pidFile(kind)));

/** Stop speech in the speech worker now (it handles SIGUSR2); nothing when no speech worker runs. */
export const stopSpeech = (): void => {
  Option.map(runningPid("speech.pid"), (pid) => {
    try {
      process.kill(pid, "SIGUSR2");
    } catch {
      // The speech worker exited meanwhile.
    }
  });
};

const processGroupOf = (pid: number): number =>
  Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());

/** Never signal pid 0 or 1, this process, or this process's own group (the CLI and its shell). */
const isSafeTarget = (pid: number): boolean => pid > 1 && pid !== process.pid && pid !== processGroupOf(process.pid);

/** Signal a process group (workers are group leaders, so their pill and players go too), else the process. */
export const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  if (!isSafeTarget(pid)) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

const removeOwnPidFile = (kind: WorkerKind): void => {
  if (Option.exists(readPid(pidFile(kind)), (pid) => pid === process.pid)) {
    removeIfPresent(stateFile(pidFile(kind)));
  }
};

/**
 * Hold this kind's worker lock for the rest of the scope and write the pid file; false when another worker of this
 * kind holds it. The kernel lock ends with its worker, even one killed with SIGKILL, so racing starters never meet a
 * stale lock to take over, and exactly one of them owns it.
 */
export const claimWorkerLock = (kind: WorkerKind): Effect.Effect<boolean, FileLockError, Scope.Scope> =>
  Effect.gen(function* () {
    makePrivateFolder(voxkeyHome());
    if (!(yield* holdLock(lockFile(kind)))) {
      return false;
    }

    writePid(pidFile(kind), process.pid);
    // Added after the lock, so it runs before the lock is dropped: the next owner's pid file is never removed.
    yield* Effect.addFinalizer(() => Effect.sync(() => removeOwnPidFile(kind)));
    return true;
  });

/** The script that is voxkey's CLI: the built main.js, or main.ts when running from source with tsx. */
const entryScript = (): string => {
  const built = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL("../cli/main.js", import.meta.url));
};

/** How to run voxkey again from here: this Node, its loader flags (tsx in development), and the entry script. */
export const voxkeyInvocation = (): {
  readonly executable: string;
  readonly scriptArguments: ReadonlyArray<string>;
} => ({
  executable: process.execPath,
  scriptArguments: [...process.execArgv, entryScript()],
});

/** Start a worker detached in its own process group, logging to its own private file (errors can quote text). */
export const spawnWorker = (kind: WorkerKind): void => {
  const log = openPrivateFile({ path: logFile(kind), flags: "a" });
  const invocation = voxkeyInvocation();
  const child = spawn(invocation.executable, [...invocation.scriptArguments, "worker", kind], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
};

export const stopRequested = (): boolean => existsSync(stateFile("stop"));

const lastLogLines = (kind: WorkerKind): string =>
  Option.getOrElse(readTextIfReadable(logFile(kind)), () => "")
    .trimEnd()
    .split("\n")
    .slice(-6)
    .join("\n");

const waitUntil = (request: { readonly done: () => boolean; readonly timeoutMs: number }) =>
  Effect.gen(function* () {
    const deadline = Date.now() + request.timeoutMs;
    while (!request.done() && Date.now() < deadline) {
      yield* Effect.sleep("50 millis");
    }
    return request.done();
  });

/** Ask both workers to stop, then force any survivor, and clear their pid, lock, and stop files. */
export const stopWorkers: Effect.Effect<void> = Effect.gen(function* () {
  touchFile(stateFile("stop"));
  const running = () => (["dictation.pid", "speech.pid"] as const).flatMap((name) => Option.toArray(runningPid(name)));
  const pids = running();
  for (const pid of pids) {
    signalGroup(pid, "SIGTERM");
  }
  yield* waitUntil({ done: () => pids.every((pid) => !isProcessAlive(pid)), timeoutMs: 4_000 });
  for (const pid of [...running(), ...Option.toArray(runningPid("pill.pid"))]) {
    signalGroup(pid, "SIGKILL");
  }
  for (const name of ["dictation.pid", "speech.pid", "pill.pid", "stop"] as const) {
    removeIfPresent(stateFile(name));
  }
  // A lock some worker still holds (say one that started after the pids were read) must stay, or a second could start.
  for (const kind of ["dictation", "speech"] as const) {
    removeFreeLock(lockFile(kind));
  }
  removeInboxFiles([".speaking"]);
});

const PS_LINE = /^\s*(\d+)\s+(.*)$/u;

/** Every voxkey worker or pill process on this Mac, found by its command line. */
const strayVoxkeyProcesses = (): ReadonlyArray<number> =>
  spawnSync("ps", ["-ax", "-o", "pid=,args="], { encoding: "utf8" })
    .stdout.split("\n")
    .flatMap((line) => {
      const match = PS_LINE.exec(line);
      const args = match?.[2] || "";
      const isWorker = args.includes("voxkey") && / worker (?:dictation|speech)$/u.test(args);
      const isPill = args.includes("osascript -l JavaScript") && args.includes(voxkeyHome());
      return isWorker || isPill ? [Number(match?.[1])] : [];
    });

/** A clean slate: stop the workers, kill any stray voxkey worker or pill, and clear every lock. */
export const resetWorkers: Effect.Effect<void> = Effect.gen(function* () {
  yield* stopWorkers;
  for (const pid of strayVoxkeyProcesses()) {
    signalGroup(pid, "SIGKILL");
  }
});

/** Start the dictation worker (which starts speech) and wait until it reports ready or fails. */
export const startWorkers: Effect.Effect<"started" | "already running", WorkerStartError> = Effect.gen(function* () {
  if (isWorkerRunning("dictation")) {
    return "already running";
  }

  removeIfPresent(stateFile("stop"));
  writeWorkerStatus({
    stage: "starting",
    detail: "Loading the dictation model",
    preview: "",
    recording: false,
    model: "",
    backend: "",
  });
  spawnWorker("dictation");
  const spawnedAt = Date.now();
  // Ready once the worker leaves "starting"; failed once it is gone after having had time to start.
  const settled = () =>
    Option.exists(readWorkerStatus(), (status) => status.stage !== "starting") ||
    (Date.now() - spawnedAt > 3_000 && !isWorkerRunning("dictation"));
  yield* waitUntil({ done: settled, timeoutMs: 120_000 });
  const status = readWorkerStatus();
  if (isWorkerRunning("dictation") && Option.exists(status, (current) => current.stage !== "unavailable")) {
    return "started";
  }

  return yield* new WorkerStartError({
    worker: "dictation",
    logFile: logFile("dictation"),
    lastLines:
      Option.getOrElse(
        Option.map(status, (current) => current.detail),
        () => "",
      ) || lastLogLines("dictation"),
  });
});

/** Start the speech worker unless it already runs; the dictation worker calls this at startup. */
export const startSpeechWorker = (): void => {
  if (!isWorkerRunning("speech")) {
    spawnWorker("speech");
  }
};

/** The last bytes of a worker's log, for `voxkey status` and failures. */
export const workerLogFile = (kind: WorkerKind): string => logFile(kind);
