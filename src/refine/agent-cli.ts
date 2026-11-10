import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const NEWLINE = "\n";

const UTF8_ENCODING = "utf8";

const STREAM_CHUNK_EVENT = "data";

const KILL_SIGNAL = "SIGKILL";

const PIPE_STDIO = "pipe";

const PATH_SEPARATOR = ":";

const SHARE_FOLDER_NAME = "share";

const PNPM_FOLDER_NAME = "pnpm";

const LIBRARY_FOLDER_NAME = "Library";

const BIN_FOLDER_NAME = "bin";

const LOCAL_FOLDER_NAME = ".local";

export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface FoundCli {
  readonly name: string;
  readonly path: string;
}

// GUI launchers and agent hooks often start with a minimal PATH that hides user-local CLIs.
const listExtraBinFolders = (): ReadonlyArray<string> => {
  const home = homedir();
  return [
    path.join(home, LOCAL_FOLDER_NAME, BIN_FOLDER_NAME),
    path.join(home, ".grok", BIN_FOLDER_NAME),
    path.join(home, ".npm-global", BIN_FOLDER_NAME),
    path.join(home, LIBRARY_FOLDER_NAME, PNPM_FOLDER_NAME),
    path.join(home, LIBRARY_FOLDER_NAME, PNPM_FOLDER_NAME, BIN_FOLDER_NAME),
    path.join(home, LOCAL_FOLDER_NAME, SHARE_FOLDER_NAME, PNPM_FOLDER_NAME),
    path.join(home, LOCAL_FOLDER_NAME, SHARE_FOLDER_NAME, PNPM_FOLDER_NAME, BIN_FOLDER_NAME),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
};

const searchPath = (): string => {
  const inheritedPath = process.env.PATH || "/usr/bin:/bin";
  const inheritedFolders = inheritedPath.split(PATH_SEPARATOR);
  const extraFolders = listExtraBinFolders();
  const folders = new Set([...inheritedFolders, ...extraFolders]);
  return [...folders].filter((folder) => folder !== "").join(PATH_SEPARATOR);
};

const isExecutableFile = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

// The full path of the first executable with this name on the search path, or null when none is installed.
export const findCli = (name: string): string | null => {
  const folders = searchPath().split(PATH_SEPARATOR);
  const candidates = folders.map((folder) => path.join(folder, name));
  return candidates.find(isExecutableFile) ?? null;
};

export const findFirstCli = (names: ReadonlyArray<string>): FoundCli | null => {
  for (const name of names) {
    const cliPath = findCli(name);

    const isCliFound = cliPath != null;
    if (isCliFound) {
      return { name, path: cliPath };
    }
  }

  return null;
};

const createCliRunError = (executable: string, issue: string): Error =>
  new Error(`${path.basename(executable)}: ${issue}`);

// stdin stays closed: several agent CLIs block on "reading additional input from stdin" when a pipe is inherited.
// Rejects when the CLI cannot start, times out, or errors. A non-zero exit is still a run.
// An aborted signal kills the child, so a caller that gave up leaves no process running.
export const runCli = (request: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}): Promise<CliRun> =>
  new Promise<CliRun>((finishRun, failRun) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: homedir(),
      env: { ...process.env, ...request.environment, NO_COLOR: "1", PATH: searchPath() },
      stdio: ["ignore", PIPE_STDIO, PIPE_STDIO],
      signal: request.signal,
      killSignal: KILL_SIGNAL,
    });
    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];
    const timer = setTimeout(() => {
      child.kill(KILL_SIGNAL);
      const timeoutError = createCliRunError(request.executable, "timed out");
      failRun(timeoutError);
    }, request.timeoutMs);
    child.stdout.on(STREAM_CHUNK_EVENT, (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on(STREAM_CHUNK_EVENT, (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      const runError = createCliRunError(request.executable, error.message);
      failRun(runError);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A child killed by a signal closes without an exit code; that counts as a failed run.
      const exitCode = code ?? 1;
      const stdout = Buffer.concat(stdoutChunks).toString(UTF8_ENCODING);
      const stderr = Buffer.concat(stderrChunks).toString(UTF8_ENCODING);
      finishRun({ exitCode, stdout, stderr });
    });
  });

export const readCliReply = (run: CliRun): string => run.stdout.trim() || run.stderr.trim();

// stderr comes first: partial stdout must never hide the error that explains the exit.
export const readCliFailureReason = (run: CliRun): string =>
  [run.stderr.trim(), run.stdout.trim()].filter((string) => string !== "").join(NEWLINE);

export const containsAny = (string: string, markers: ReadonlyArray<string>): boolean => {
  const lowercase = string.toLowerCase();
  return markers.some((marker) => lowercase.includes(marker));
};

export const listNonBlankLines = (string: string): ReadonlyArray<string> =>
  string
    .split(NEWLINE)
    .map((line) => line.trim())
    .filter((line) => line !== "");

// A CLI that fails to start, times out, or errors is logged and has no lines, so this never rejects.
export const runCliLines = async (request: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<ReadonlyArray<string>> => {
  try {
    const run = await runCli(request);
    return listNonBlankLines(`${run.stdout}\n${run.stderr}`);
  } catch (error) {
    console.error({ executable: request.executable, error });
    return [];
  }
};

export const parseDocumentOrNull = (string: string): unknown => {
  try {
    return JSON.parse(string);
  } catch {
    return null;
  }
};

export const dedupe = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const trimmedNames = names.map((name) => name.trim());
  const uniqueNames = new Set(trimmedNames);
  return [...uniqueNames].filter((name) => name !== "");
};
