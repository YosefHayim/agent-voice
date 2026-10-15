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

const WORKER_FILES = {
  dictation: { pid: "dictation.pid", lock: "dictation.lock", log: "dictation-worker.log" },
  speech: { pid: "speech.pid", lock: "speech.lock", log: "speech-worker.log" },
} as const;

const PROCESS_ROW = /^\s*(\S+)\s+(.*)$/u;
const WORKER_COMMAND = / worker (?:dictation|speech)$/u;

export class WorkerStartError extends Schema.TaggedError<WorkerStartError>()("WorkerStartError", {
  worker: Schema.String,
  logFile: Schema.String,
  lastLines: Schema.String,
}) {
  get message(): string {
    const summary = `The ${this.worker} worker did not start. See ${this.logFile}.`;
    if (this.lastLines === "") {
      return summary;
    }

    return `${summary}\n${this.lastLines}`;
  }
}

const workerLockPath = (kind: WorkerKind): string => stateFile(WORKER_FILES[kind].lock);

const workerLogPath = (kind: WorkerKind): string => stateFile(WORKER_FILES[kind].log);

const runPs = (psArguments: ReadonlyArray<string>): string => {
  const ps = spawnSync("ps", psArguments, { encoding: "utf8" });
  return ps.stdout.trim();
};

const sendSignal = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

// A zombie still answers signal 0 until it is reaped, so it is checked by its ps state.
const isZombie = (pid: number): boolean => {
  const state = runPs(["-o", "state=", "-p", String(pid)]);
  return state.startsWith("Z");
};

const isProcessAlive = (pid: number): boolean => sendSignal(pid, 0) && !isZombie(pid);

const isPillCommand = (commandLine: string): boolean => {
  const home = voxkeyHome();
  return commandLine.includes("osascript -l JavaScript") && commandLine.includes(home);
};

const isUsablePid = (pid: number): boolean => Number.isInteger(pid) && pid > 1;

const decodePid = Schema.decodeUnknownOption(Schema.NumberFromString);

export const readPid = (name: PidFileName): Option.Option<number> => {
  const pidPath = stateFile(name);
  return readTextIfReadable(pidPath).pipe(
    Option.map((text) => text.trim()),
    Option.flatMap(decodePid),
    Option.filter(isUsablePid),
  );
};

export const writePid = (name: PidFileName, pid: number): void => {
  const home = voxkeyHome();
  makePrivateFolder(home);
  const pidPath = stateFile(name);
  writeFileSync(pidPath, `${pid}`);
};

// A pid can be reused by another program (say after a reboot), so a pid file is trusted, and its pid signalled,
// only while that pid still runs the command line the file names.
const isNamedProcess = (name: PidFileName, commandLine: string): boolean => {
  switch (name) {
    case "dictation.pid":
      return commandLine.endsWith(" worker dictation");
    case "speech.pid":
      return commandLine.endsWith(" worker speech");
    case "pill.pid":
      return isPillCommand(commandLine);
  }
};

const isRunningAs = (name: PidFileName, pid: number): boolean => {
  const processRow = runPs(["-o", "state=,args=", "-p", String(pid)]);
  const match = PROCESS_ROW.exec(processRow);
  if (match === null) {
    return false;
  }

  const state = match[1] || "";
  const commandLine = match[2] || "";
  return !state.startsWith("Z") && isNamedProcess(name, commandLine);
};

export const runningPid = (name: PidFileName): Option.Option<number> =>
  readPid(name).pipe(Option.filter((pid) => isRunningAs(name, pid)));

export const isWorkerRunning = (kind: WorkerKind): boolean => {
  const workerPid = runningPid(WORKER_FILES[kind].pid);
  return Option.isSome(workerPid);
};

// The speech worker drops the reply it is reading on SIGUSR2.
export const stopSpeech = (): void => {
  const speechPid = runningPid("speech.pid");
  if (Option.isSome(speechPid)) {
    sendSignal(speechPid.value, "SIGUSR2");
  }
};

const processGroupOf = (pid: number): number => {
  const group = runPs(["-o", "pgid=", "-p", String(pid)]);
  return Number(group);
};

// Never signal pid 0 or 1, this process, or this process's own group (the CLI and its shell).
const isSafeTarget = (pid: number): boolean => pid > 1 && pid !== process.pid && pid !== processGroupOf(process.pid);

// Workers lead their process group, so their pill and players stop with them.
export const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  if (!isSafeTarget(pid)) {
    return;
  }

  const signalledGroup = sendSignal(-pid, signal);
  if (signalledGroup) {
    return;
  }

  sendSignal(pid, signal);
};

const removeOwnPidFile = (kind: WorkerKind): void => {
  const pidName = WORKER_FILES[kind].pid;
  const savedPid = readPid(pidName);
  const isOwnPid = Option.contains(savedPid, process.pid);
  if (isOwnPid) {
    const pidPath = stateFile(pidName);
    removeIfPresent(pidPath);
  }
};

// False when another worker of this kind holds the lock. The kernel lock ends with its worker, even one killed with
// SIGKILL, so racing starters never meet a stale lock to take over, and exactly one of them owns it.
export const claimWorkerLock = (kind: WorkerKind): Effect.Effect<boolean, FileLockError, Scope.Scope> =>
  Effect.gen(function* () {
    const home = voxkeyHome();
    makePrivateFolder(home);
    const lock = workerLockPath(kind);
    const ownsLock = yield* holdLock(lock);
    if (!ownsLock) {
      return false;
    }

    writePid(WORKER_FILES[kind].pid, process.pid);
    // Added after the lock, so it runs before the lock is dropped: the next owner's pid file is never removed.
    yield* Effect.addFinalizer(() => Effect.sync(() => removeOwnPidFile(kind)));
    return true;
  });

// From source there is no built main.js next to this file, so tsx runs main.ts.
const entryScript = (): string => {
  const builtEntry = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  if (existsSync(builtEntry)) {
    return builtEntry;
  }

  return fileURLToPath(new URL("../cli/main.ts", import.meta.url));
};

// This Node with its loader flags, so a worker or a hook runs the same voxkey as the command that started it.
export const voxkeyInvocation = (): {
  readonly executable: string;
  readonly scriptArguments: ReadonlyArray<string>;
} => ({
  executable: process.execPath,
  scriptArguments: [...process.execArgv, entryScript()],
});

// Detached in its own process group. Its log is private because errors can quote dictated text.
export const spawnWorker = (kind: WorkerKind): void => {
  const logPath = workerLogPath(kind);
  const log = openPrivateFile({ path: logPath, flags: "a" });
  const invocation = voxkeyInvocation();
  const child = spawn(invocation.executable, [...invocation.scriptArguments, "worker", kind], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
};

export const stopRequested = (): boolean => {
  const stopPath = stateFile("stop");
  return existsSync(stopPath);
};

const lastLogLines = (kind: WorkerKind): string => {
  const logPath = workerLogPath(kind);
  const logText = readTextIfReadable(logPath).pipe(Option.getOrElse(() => ""));
  return logText.trimEnd().split("\n").slice(-6).join("\n");
};

const waitUntil = (request: { readonly done: () => boolean; readonly timeoutMs: number }) =>
  Effect.gen(function* () {
    const deadline = Date.now() + request.timeoutMs;
    while (!request.done() && Date.now() < deadline) {
      yield* Effect.sleep("50 millis");
    }
    return request.done();
  });

const runningWorkerPids = (): ReadonlyArray<number> =>
  (["dictation.pid", "speech.pid"] as const).flatMap((name) => {
    const workerPid = runningPid(name);
    return Option.toArray(workerPid);
  });

// Asks both workers to stop, forces any survivor, and clears their pid, lock, and stop files.
export const stopWorkers: Effect.Effect<void> = Effect.gen(function* () {
  const stopPath = stateFile("stop");
  touchFile(stopPath);
  const stoppingPids = runningWorkerPids();
  for (const pid of stoppingPids) {
    signalGroup(pid, "SIGTERM");
  }
  yield* waitUntil({ done: () => !stoppingPids.some(isProcessAlive), timeoutMs: 4_000 });

  const pillPid = runningPid("pill.pid");
  const survivors = [...runningWorkerPids(), ...Option.toArray(pillPid)];
  for (const pid of survivors) {
    signalGroup(pid, "SIGKILL");
  }
  for (const name of ["dictation.pid", "speech.pid", "pill.pid", "stop"] as const) {
    const filePath = stateFile(name);
    removeIfPresent(filePath);
  }
  // A lock some worker still holds (say one that started after the pids were read) must stay, or a second could start.
  for (const kind of ["dictation", "speech"] as const) {
    const lock = workerLockPath(kind);
    removeFreeLock(lock);
  }
  removeInboxFiles([".speaking"]);
});

// Every voxkey worker or pill process on this Mac, found by its command line.
const strayVoxkeyProcesses = (): ReadonlyArray<number> => {
  const processList = runPs(["-ax", "-o", "pid=,args="]);
  return processList.split("\n").flatMap((line) => {
    const match = PROCESS_ROW.exec(line);
    const commandLine = match?.[2] || "";
    const isWorker = commandLine.includes("voxkey") && WORKER_COMMAND.test(commandLine);
    const isStray = isWorker || isPillCommand(commandLine);
    if (!isStray) {
      return [];
    }

    return [Number(match?.[1])];
  });
};

export const resetWorkers: Effect.Effect<void> = Effect.gen(function* () {
  yield* stopWorkers;
  for (const pid of strayVoxkeyProcesses()) {
    signalGroup(pid, "SIGKILL");
  }
});

// The dictation worker starts the speech worker itself.
export const startWorkers: Effect.Effect<"started" | "already running", WorkerStartError> = Effect.gen(function* () {
  if (isWorkerRunning("dictation")) {
    return "already running";
  }

  const stopPath = stateFile("stop");
  removeIfPresent(stopPath);
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
  const settled = () => {
    const hasLeftStarting = readWorkerStatus().pipe(Option.exists((status) => status.stage !== "starting"));
    const hasDied = Date.now() - spawnedAt > 3_000 && !isWorkerRunning("dictation");
    return hasLeftStarting || hasDied;
  };
  yield* waitUntil({ done: settled, timeoutMs: 120_000 });

  const status = readWorkerStatus();
  const isAvailable = status.pipe(Option.exists((current) => current.stage !== "unavailable"));
  if (isAvailable && isWorkerRunning("dictation")) {
    return "started";
  }

  const statusDetail = status.pipe(
    Option.map((current) => current.detail),
    Option.getOrElse(() => ""),
  );
  const lastLines = statusDetail || lastLogLines("dictation");
  return yield* new WorkerStartError({ worker: "dictation", logFile: workerLogPath("dictation"), lastLines });
});

export const startSpeechWorker = (): void => {
  if (isWorkerRunning("speech")) {
    return;
  }

  spawnWorker("speech");
};
