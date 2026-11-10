import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAgentVoiceHome, readStateFile } from "#src/settings/agent-voice-home.js";
import { sleep } from "#src/sleep.js";
import { removeInboxFiles } from "#src/speech/inbox.js";
import { holdLock, type ReleaseLock, removeFreeLock } from "#src/storage/file-lock.js";
import {
  makePrivateFolder,
  openPrivateFile,
  readTextIfReadable,
  removeIfPresent,
  touchFile,
} from "#src/storage/state-files.js";
import { readWorkerStatus, writeWorkerStatus } from "./worker-status.js";

type WorkerKind = "dictation" | "speech";

type PidFileName = "dictation.pid" | "speech.pid" | "pill.pid";

const WORKER_FILES = {
  dictation: { pid: "dictation.pid", lock: "dictation.lock", log: "dictation-worker.log" },
  speech: { pid: "speech.pid", lock: "speech.lock", log: "speech-worker.log" },
} as const;

const PROCESS_ROW = /^\s*(\S+)\s+(.*)$/u;
const WORKER_COMMAND = / worker (?:dictation|speech)$/u;

const readWorkerLockPath = (kind: WorkerKind): string => readStateFile(WORKER_FILES[kind].lock);

const readWorkerLogPath = (kind: WorkerKind): string => readStateFile(WORKER_FILES[kind].log);

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
  const processState = runPs(["-o", "state=", "-p", String(pid)]);
  return processState.startsWith("Z");
};

const isProcessAlive = (pid: number): boolean => sendSignal(pid, 0) && !isZombie(pid);

const isPillCommand = (commandLine: string): boolean => {
  const home = readAgentVoiceHome();
  return commandLine.includes("osascript -l JavaScript") && commandLine.includes(home);
};

const isUsablePid = (pid: number): boolean => Number.isInteger(pid) && pid > 1;

// The pid file's text as a pid, or null when the file is missing, empty, or not a number.
export const readPid = (name: PidFileName): number | null => {
  const pidText = readTextIfReadable(readStateFile(name));

  const isThereNoPidText = pidText === null;
  if (isThereNoPidText) {
    return null;
  }

  const pid = Number(pidText.trim());
  return isUsablePid(pid) ? pid : null;
};

export const writePid = (name: PidFileName, pid: number): void => {
  const home = readAgentVoiceHome();
  makePrivateFolder(home);
  const pidPath = readStateFile(name);
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

  const processRowMatch = PROCESS_ROW.exec(processRow);

  const isProcessMissing = processRowMatch === null;
  if (isProcessMissing) {
    return false;
  }

  const processState = processRowMatch[1] || "";
  const commandLine = processRowMatch[2] || "";
  return !processState.startsWith("Z") && isNamedProcess(name, commandLine);
};

// The pid from the pid file, only when that process still runs as the named worker.
export const readRunningPid = (name: PidFileName): number | null => {
  const savedPid = readPid(name);

  const isThereNoSavedPid = savedPid === null;
  if (isThereNoSavedPid) {
    return null;
  }

  return isRunningAs(name, savedPid) ? savedPid : null;
};

const listRunningPidList = (name: PidFileName): ReadonlyArray<number> => {
  const workerPid = readRunningPid(name);

  const isThereNoRunningPid = workerPid === null;
  if (isThereNoRunningPid) {
    return [];
  }

  return [workerPid];
};

export const isWorkerRunning = (kind: WorkerKind): boolean => {
  const workerPid = readRunningPid(WORKER_FILES[kind].pid);
  return workerPid !== null;
};

// The speech worker drops the reply it is reading on SIGUSR2.
export const stopSpeech = (): void => {
  const speechPid = readRunningPid("speech.pid");

  const isSpeechRunning = speechPid !== null;
  if (isSpeechRunning) {
    sendSignal(speechPid, "SIGUSR2");
  }
};

const readProcessGroupId = (pid: number): number => {
  const group = runPs(["-o", "pgid=", "-p", String(pid)]);
  return Number(group);
};

// Never signal pid 0 or 1, this process, or this process's own group (the CLI and its shell).
const isSafeTarget = (pid: number): boolean =>
  pid > 1 && pid !== process.pid && pid !== readProcessGroupId(process.pid);

// Workers lead their process group, so their pill and players stop with them.
export const sendSignalToGroup = (pid: number, signal: NodeJS.Signals): void => {
  const isNotSafeTargetPid = !isSafeTarget(pid);
  if (isNotSafeTargetPid) {
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

  const isOwnPid = savedPid === process.pid;
  if (isOwnPid) {
    const pidPath = readStateFile(pidName);
    removeIfPresent(pidPath);
  }
};

// Null when another worker of this kind holds the lock. The kernel lock ends with its worker, even one killed with
// SIGKILL, so racing starters never meet a stale lock to take over, and exactly one of them owns it.
// The returned release removes the pid file first, then drops the lock, so the next owner's pid file is never removed.
export const claimWorkerLock = (kind: WorkerKind): ReleaseLock | null => {
  const home = readAgentVoiceHome();
  makePrivateFolder(home);
  const releaseLock = holdLock(readWorkerLockPath(kind));

  const isLockHeldByAnother = releaseLock === null;
  if (isLockHeldByAnother) {
    return null;
  }

  writePid(WORKER_FILES[kind].pid, process.pid);
  return () => {
    removeOwnPidFile(kind);
    releaseLock();
  };
};

// From source there is no built main.js next to this file, so tsx runs main.ts.
const readEntryScript = (): string => {
  const builtEntry = fileURLToPath(new URL("../cli/main.js", import.meta.url));

  const hasBuiltEntry = existsSync(builtEntry);
  if (hasBuiltEntry) {
    return builtEntry;
  }

  return fileURLToPath(new URL("../cli/main.ts", import.meta.url));
};

// This Node with its loader flags, so a worker or a hook runs the same agent-voice as the command that started it.
export const readAgentVoiceInvocation = (): {
  readonly executable: string;
  readonly scriptArguments: ReadonlyArray<string>;
} => ({
  executable: process.execPath,
  scriptArguments: [...process.execArgv, readEntryScript()],
});

// Detached in its own process group. Its log is private because errors can quote dictated text.
export const spawnWorker = (kind: WorkerKind): void => {
  const logPath = readWorkerLogPath(kind);
  const log = openPrivateFile({ path: logPath, flags: "a" });
  const invocation = readAgentVoiceInvocation();
  const child = spawn(invocation.executable, [...invocation.scriptArguments, "worker", kind], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
};

export const stopRequested = (): boolean => {
  const stopPath = readStateFile("stop");
  return existsSync(stopPath);
};

const readLastLogLines = (kind: WorkerKind): string => {
  const logPath = readWorkerLogPath(kind);
  const logText = readTextIfReadable(logPath) ?? "";
  return logText.trimEnd().split("\n").slice(-6).join("\n");
};

const waitUntil = async (request: { readonly done: () => boolean; readonly timeoutMs: number }): Promise<void> => {
  const pollIntervalMilliseconds = 50;
  const deadline = Date.now() + request.timeoutMs;
  while (!request.done() && Date.now() < deadline) {
    await sleep(pollIntervalMilliseconds);
  }
};

const listRunningWorkerPids = (): ReadonlyArray<number> => [
  ...listRunningPidList("dictation.pid"),
  ...listRunningPidList("speech.pid"),
];

// Asks both workers to stop, forces any survivor, and clears their pid, lock, and stop files.
export const stopWorkers = async (): Promise<void> => {
  const stopPath = readStateFile("stop");
  touchFile(stopPath);
  const stoppingPids = listRunningWorkerPids();
  for (const pid of stoppingPids) {
    sendSignalToGroup(pid, "SIGTERM");
  }
  const stopTimeoutMilliseconds = 4_000;
  await waitUntil({ done: () => !stoppingPids.some(isProcessAlive), timeoutMs: stopTimeoutMilliseconds });

  const survivors = [...listRunningWorkerPids(), ...listRunningPidList("pill.pid")];
  for (const pid of survivors) {
    sendSignalToGroup(pid, "SIGKILL");
  }
  for (const name of ["dictation.pid", "speech.pid", "pill.pid", "stop"] as const) {
    const filePath = readStateFile(name);
    removeIfPresent(filePath);
  }
  // A lock some worker still holds (say one that started after the pids were read) must stay, or a second could start.
  for (const kind of ["dictation", "speech"] as const) {
    const lock = readWorkerLockPath(kind);
    removeFreeLock(lock);
  }
  removeInboxFiles([".speaking"]);
};

// Every agent-voice worker or pill process on this Mac, found by its command line.
const listStrayAgentVoiceProcesses = (): ReadonlyArray<number> => {
  const processList = runPs(["-ax", "-o", "pid=,args="]);
  return processList.split("\n").flatMap((line) => {
    const processRowMatch = PROCESS_ROW.exec(line);
    const commandLine = processRowMatch?.[2] || "";
    const isWorker = commandLine.includes("agent-voice") && WORKER_COMMAND.test(commandLine);

    const isNotStray = !isWorker && !isPillCommand(commandLine);
    if (isNotStray) {
      return [];
    }

    return [Number(match?.[1])];
  });
};

export const resetWorkers = async (): Promise<void> => {
  await stopWorkers();
  for (const pid of listStrayAgentVoiceProcesses()) {
    sendSignalToGroup(pid, "SIGKILL");
  }
};

const readDictationStartFailureMessage = (lastLines: string): string => {
  const summary = `The dictation worker did not start. See ${readWorkerLogPath("dictation")}.`;

  const isLastLinesEmpty = lastLines === "";
  if (isLastLinesEmpty) {
    return summary;
  }

  return `${summary}\n${lastLines}`;
};

// The dictation worker starts the speech worker itself. Throws an Error with the worker's last log lines when it fails.
export const startWorkers = async (): Promise<"started" | "already running"> => {
  const isDictationAlreadyRunning = isWorkerRunning("dictation");
  if (isDictationAlreadyRunning) {
    return "already running";
  }

  const stopPath = readStateFile("stop");
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
  const isSettled = () => {
    const currentStatus = readWorkerStatus();
    const hasLeftStarting = currentStatus !== null && currentStatus.stage !== "starting";
    const startupGraceMilliseconds = 3_000;
    const hasDied = Date.now() - spawnedAt > startupGraceMilliseconds && !isWorkerRunning("dictation");
    return hasLeftStarting || hasDied;
  };
  const startTimeoutMilliseconds = 120_000;
  await waitUntil({ done: isSettled, timeoutMs: startTimeoutMilliseconds });

  const status = readWorkerStatus();
  const isAvailable = status !== null && status.stage !== "unavailable";

  const isDictationStarted = isAvailable && isWorkerRunning("dictation");
  if (isDictationStarted) {
    return "started";
  }

  const statusDetail = status?.detail ?? "";
  const lastLines = statusDetail || readLastLogLines("dictation");
  throw new Error(readDictationStartFailureMessage(lastLines));
};

export const startSpeechWorker = (): void => {
  if (isWorkerRunning("speech")) {
    return;
  }

  spawnWorker("speech");
};
