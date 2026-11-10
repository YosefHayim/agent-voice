import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAgentVoiceHome, readStatusFile } from "#src/settings/agent-voice-home.js";
import { sleep } from "#src/sleep.js";
import { removeInboxFiles } from "#src/speech/inbox.js";
import { holdLock, type ReleaseLock, removeFreeLock } from "#src/storage/file-lock.js";
import {
  makePrivateFolder,
  openPrivateFile,
  readFileIfReadable,
  removeFileIfExists,
  touchFile,
} from "#src/storage/state-files.js";
import { readWorkerStatus, writeWorkerStatus } from "./worker-status.js";

const STARTING_STAGE = "starting";

const SPEECH_WORKER_NAME = "speech";

const DICTATION_WORKER_NAME = "dictation";

const KILL_SIGNAL = "SIGKILL";

const NEWLINE = "\n";

const STOP_STATUS_NAME = "stop";

const ZOMBIE_PROCESS_STATUS = "Z";

const PS_PID_FLAG = "-p";

const PS_FIELDS_FLAG = "-o";

const PILL_PID_FILE = "pill.pid";

const SPEECH_PID_FILE = "speech.pid";

const DICTATION_PID_FILE = "dictation.pid";

type WorkerKind = "dictation" | "speech";

type PidFileName = "dictation.pid" | "speech.pid" | "pill.pid";

const WORKER_FILES = {
  dictation: { pid: DICTATION_PID_FILE, lock: "dictation.lock", log: "dictation-worker.log" },
  speech: { pid: SPEECH_PID_FILE, lock: "speech.lock", log: "speech-worker.log" },
} as const;

const PS_LINE_PATTERN = /^\s*(\S+)\s+(.*)$/u;

const readWorkerLockPath = (kind: WorkerKind): string => readStatusFile(WORKER_FILES[kind].lock);

const readWorkerLogPath = (kind: WorkerKind): string => readStatusFile(WORKER_FILES[kind].log);

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
  const processStatus = runPs([PS_FIELDS_FLAG, "state=", PS_PID_FLAG, String(pid)]);
  return processStatus.startsWith(ZOMBIE_PROCESS_STATUS);
};

const isProcessAlive = (pid: number): boolean => sendSignal(pid, 0) && !isZombie(pid);

const isPillCommand = (commandLine: string): boolean => {
  const home = readAgentVoiceHome();
  return commandLine.includes("osascript -l JavaScript") && commandLine.includes(home);
};

const isUsablePid = (pid: number): boolean => Number.isInteger(pid) && pid > 1;

// The pid file's text as a pid, or null when the file is missing, empty, or not a number.
export const readPid = (name: PidFileName): number | null => {
  const pidFileReading = readFileIfReadable(readStatusFile(name));

  const isPidFileMissing = pidFileReading == null;
  if (isPidFileMissing) {
    return null;
  }

  const pid = Number(pidFileReading.trim());
  return isUsablePid(pid) ? pid : null;
};

export const writePid = (name: PidFileName, pid: number): void => {
  const home = readAgentVoiceHome();
  makePrivateFolder(home);
  const pidPath = readStatusFile(name);
  writeFileSync(pidPath, `${pid}`);
};

// A pid can be reused by another program (say after a reboot), so a pid file is trusted, and its pid signalled,
// only while that pid still runs the command line the file names.
const isNamedProcess = (name: PidFileName, commandLine: string): boolean => {
  switch (name) {
    case DICTATION_PID_FILE:
      return commandLine.endsWith(" worker dictation");
    case SPEECH_PID_FILE:
      return commandLine.endsWith(" worker speech");
    case PILL_PID_FILE:
      return isPillCommand(commandLine);
  }
};

const isRunningAs = (name: PidFileName, pid: number): boolean => {
  const psLine = runPs([PS_FIELDS_FLAG, "state=,args=", PS_PID_FLAG, String(pid)]);

  const parsedPsLine = PS_LINE_PATTERN.exec(psLine);

  const isProcessMissing = parsedPsLine == null;
  if (isProcessMissing) {
    return false;
  }

  const processStatus = parsedPsLine[1] || "";
  const commandLine = parsedPsLine[2] || "";
  return !processStatus.startsWith(ZOMBIE_PROCESS_STATUS) && isNamedProcess(name, commandLine);
};

// The pid from the pid file, only when that process still runs as the named worker.
export const readRunningPid = (name: PidFileName): number | null => {
  const savedPid = readPid(name);

  const isThereNoSavedPid = savedPid == null;
  if (isThereNoSavedPid) {
    return null;
  }

  return isRunningAs(name, savedPid) ? savedPid : null;
};

const listRunningPidList = (name: PidFileName): ReadonlyArray<number> => {
  const workerPid = readRunningPid(name);

  const isThereNoRunningPid = workerPid == null;
  if (isThereNoRunningPid) {
    return [];
  }

  return [workerPid];
};

export const isWorkerRunning = (kind: WorkerKind): boolean => {
  const workerPid = readRunningPid(WORKER_FILES[kind].pid);
  return workerPid != null;
};

// The speech worker drops the reply it is reading on SIGUSR2.
export const stopSpeech = (): void => {
  const speechPid = readRunningPid(SPEECH_PID_FILE);

  const isSpeechRunning = speechPid != null;
  if (isSpeechRunning) {
    sendSignal(speechPid, "SIGUSR2");
  }
};

const readProcessGroupId = (pid: number): number => {
  const group = runPs([PS_FIELDS_FLAG, "pgid=", PS_PID_FLAG, String(pid)]);
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
    const pidPath = readStatusFile(pidName);
    removeFileIfExists(pidPath);
  }
};

// Null when another worker of this kind holds the lock. The kernel lock ends with its worker, even one killed with
// SIGKILL, so racing starters never meet a stale lock to take over, and exactly one of them owns it.
// The returned release removes the pid file first, then drops the lock, so the next owner's pid file is never removed.
export const claimWorkerLock = (kind: WorkerKind): ReleaseLock | null => {
  const home = readAgentVoiceHome();
  makePrivateFolder(home);
  const releaseLock = holdLock(readWorkerLockPath(kind));

  const isLockHeldByAnother = releaseLock == null;
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
const readLineScript = (): string => {
  const builtLine = fileURLToPath(new URL("../cli/main.js", import.meta.url));

  const hasBuiltLine = existsSync(builtLine);
  if (hasBuiltLine) {
    return builtLine;
  }

  return fileURLToPath(new URL("../cli/main.ts", import.meta.url));
};

// This Node with its loader flags, so a worker or a hook runs the same agent-voice as the command that started it.
export const readAgentVoiceInvocation = (): {
  readonly executable: string;
  readonly scriptArguments: ReadonlyArray<string>;
} => ({
  executable: process.execPath,
  scriptArguments: [...process.execArgv, readLineScript()],
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
  const stopPath = readStatusFile(STOP_STATUS_NAME);
  return existsSync(stopPath);
};

const readLastLogLines = (kind: WorkerKind): string => {
  const logPath = readWorkerLogPath(kind);
  const logFileReading = readFileIfReadable(logPath) ?? "";
  const lastLogLinesFrom = -6;

  return logFileReading.trimEnd().split(NEWLINE).slice(lastLogLinesFrom).join(NEWLINE);
};

const waitUntil = async (request: { readonly done: () => boolean; readonly timeoutMs: number }): Promise<void> => {
  const pollIntervalMilliseconds = 50;
  const deadline = Date.now() + request.timeoutMs;
  while (!request.done() && Date.now() < deadline) {
    await sleep(pollIntervalMilliseconds);
  }
};

const listRunningWorkerPids = (): ReadonlyArray<number> => [
  ...listRunningPidList(DICTATION_PID_FILE),
  ...listRunningPidList(SPEECH_PID_FILE),
];

export const stopWorkers = async (): Promise<void> => {
  const stopPath = readStatusFile(STOP_STATUS_NAME);
  touchFile(stopPath);
  const stoppingPids = listRunningWorkerPids();
  for (const pid of stoppingPids) {
    sendSignalToGroup(pid, "SIGTERM");
  }
  const stopTimeoutMilliseconds = 4_000;
  await waitUntil({ done: () => !stoppingPids.some(isProcessAlive), timeoutMs: stopTimeoutMilliseconds });

  const survivors = [...listRunningWorkerPids(), ...listRunningPidList(PILL_PID_FILE)];
  for (const pid of survivors) {
    sendSignalToGroup(pid, KILL_SIGNAL);
  }
  for (const name of [DICTATION_PID_FILE, SPEECH_PID_FILE, PILL_PID_FILE, STOP_STATUS_NAME] as const) {
    const filePath = readStatusFile(name);
    removeFileIfExists(filePath);
  }
  // A lock some worker still holds (say one that started after the pids were read) must stay, or a second could start.
  for (const kind of [DICTATION_WORKER_NAME, SPEECH_WORKER_NAME] as const) {
    const lock = readWorkerLockPath(kind);
    removeFreeLock(lock);
  }
  removeInboxFiles([".speaking"]);
};

const listStrayAgentVoiceProcesses = (): ReadonlyArray<number> => {
  const processList = runPs(["-ax", PS_FIELDS_FLAG, "pid=,args="]);
  return processList.split(NEWLINE).flatMap((line) => {
    const parsedPsLine = PS_LINE_PATTERN.exec(line);
    const commandLine = parsedPsLine?.[2] || "";
    const isWorker = commandLine.includes("agent-voice") && / worker (?:dictation|speech)$/u.test(commandLine);

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
    sendSignalToGroup(pid, KILL_SIGNAL);
  }
};

const readDictationStartFailureMessage = (lastLines: string): string => {
  const summary = `The dictation worker did not start. See ${readWorkerLogPath(DICTATION_WORKER_NAME)}.`;

  const isLastLinesEmpty = lastLines === "";
  if (isLastLinesEmpty) {
    return summary;
  }

  return `${summary}\n${lastLines}`;
};

// The dictation worker starts the speech worker itself. Throws an Error with the worker's last log lines when it fails.
export const startWorkers = async (): Promise<"started" | "already running"> => {
  const isDictationAlreadyRunning = isWorkerRunning(DICTATION_WORKER_NAME);
  if (isDictationAlreadyRunning) {
    return "already running";
  }

  const stopPath = readStatusFile(STOP_STATUS_NAME);
  removeFileIfExists(stopPath);
  writeWorkerStatus({
    stage: STARTING_STAGE,
    detail: "Loading the dictation model",
    preview: "",
    recording: false,
    model: "",
    backend: "",
  });
  spawnWorker(DICTATION_WORKER_NAME);
  const spawnedAt = Date.now();
  // Ready once the worker leaves "starting"; failed once it is gone after having had time to start.
  const isSettled = () => {
    const currentStatus = readWorkerStatus();
    const hasLeftStarting = currentStatus != null && currentStatus.stage !== STARTING_STAGE;
    const startupGraceMilliseconds = 3_000;
    const hasDied = Date.now() - spawnedAt > startupGraceMilliseconds && !isWorkerRunning(DICTATION_WORKER_NAME);
    return hasLeftStarting || hasDied;
  };
  const startTimeoutMilliseconds = 120_000;
  await waitUntil({ done: isSettled, timeoutMs: startTimeoutMilliseconds });

  const status = readWorkerStatus();
  const isAvailable = status != null && status.stage !== "unavailable";

  const isDictationStarted = isAvailable && isWorkerRunning(DICTATION_WORKER_NAME);
  if (isDictationStarted) {
    return "started";
  }

  const statusDetail = status?.detail ?? "";
  const lastLines = statusDetail || readLastLogLines(DICTATION_WORKER_NAME);
  throw new Error(readDictationStartFailureMessage(lastLines));
};

export const startSpeechWorker = (): void => {
  if (isWorkerRunning(SPEECH_WORKER_NAME)) {
    return;
  }

  spawnWorker(SPEECH_WORKER_NAME);
};
