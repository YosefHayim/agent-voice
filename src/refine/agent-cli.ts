import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
    path.join(home, ".local", "bin"),
    path.join(home, ".grok", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, "Library", "pnpm", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".local", "share", "pnpm", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
};

const searchPath = (): string => {
  const inheritedPath = process.env.PATH || "/usr/bin:/bin";
  const inheritedFolders = inheritedPath.split(":");
  const extraFolders = listExtraBinFolders();
  const folders = new Set([...inheritedFolders, ...extraFolders]);
  return [...folders].filter((folder) => folder !== "").join(":");
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
  const folders = searchPath().split(":");
  const candidates = folders.map((folder) => path.join(folder, name));
  return candidates.find(isExecutableFile) ?? null;
};

export const findFirstCli = (names: ReadonlyArray<string>): FoundCli | null => {
  for (const name of names) {
    const cliPath = findCli(name);

    const isCliFound = cliPath !== null;
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
      stdio: ["ignore", "pipe", "pipe"],
      signal: request.signal,
      killSignal: "SIGKILL",
    });
    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      failRun(createCliRunError(request.executable, "timed out"));
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      failRun(createCliRunError(request.executable, error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A child killed by a signal closes without an exit code; that counts as a failed run.
      const exitCode = code ?? 1;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      finishRun({ exitCode, stdout, stderr });
    });
  });

export const readCliOutputText = (run: CliRun): string => run.stdout.trim() || run.stderr.trim();

// stderr comes first: partial stdout must never hide the error that explains the exit.
export const readCliFailureText = (run: CliRun): string =>
  [run.stderr.trim(), run.stdout.trim()].filter((text) => text !== "").join("\n");

export const containsAny = (text: string, markers: ReadonlyArray<string>): boolean => {
  const lowercase = text.toLowerCase();
  return markers.some((marker) => lowercase.includes(marker));
};

export const listNonBlankLines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
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

// Not JSON gives null, the same as JSON null.
export const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const dedupe = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const trimmedNames = names.map((name) => name.trim());
  const uniqueNames = new Set(trimmedNames);
  return [...uniqueNames].filter((name) => name !== "");
};
