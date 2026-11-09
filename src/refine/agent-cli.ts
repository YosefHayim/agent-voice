import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";

const cliRunSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});

export type CliRun = Schema.Schema.Type<typeof cliRunSchema>;

export class CliRunError extends Schema.TaggedError<CliRunError>()("CliRunError", {
  executable: Schema.String,
  issue: Schema.String,
}) {
  get message(): string {
    return `${path.basename(this.executable)}: ${this.issue}`;
  }
}

// GUI launchers and agent hooks often start with a minimal PATH that hides user-local CLIs.
const extraBinFolders = (): ReadonlyArray<string> => {
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
  const extraFolders = extraBinFolders();
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

export const findCli = (name: string): Option.Option<string> => {
  const folders = searchPath().split(":");
  const candidates = folders.map((folder) => path.join(folder, name));
  const executable = candidates.find(isExecutableFile);
  return Option.fromNullable(executable);
};

export const findFirstCli = (
  names: ReadonlyArray<string>,
): Option.Option<{ readonly name: string; readonly path: string }> => {
  const installed = names.map((name) => findCli(name).pipe(Option.map((cliPath) => ({ name, path: cliPath }))));
  return Option.firstSomeOf(installed);
};

// A child killed by a signal closes without an exit code.
const exitCodeOf = (code: number | null): number => {
  if (code === null) {
    return 1;
  }

  return code;
};

// stdin stays closed: several agent CLIs block on "reading additional input from stdin" when a pipe is inherited.
export const runCli = (request: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>>;
}): Effect.Effect<CliRun, CliRunError> =>
  Effect.async<CliRun, CliRunError>((resume) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: homedir(),
      env: { ...process.env, ...request.environment, NO_COLOR: "1", PATH: searchPath() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];
    const failRun = (issue: string): void => {
      const failedRun = Effect.fail(new CliRunError({ executable: request.executable, issue }));
      resume(failedRun);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      failRun("timed out");
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      failRun(error.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = exitCodeOf(code);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const finishedRun = Effect.succeed({ exitCode, stdout, stderr });
      resume(finishedRun);
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });

export const cliOutputText = (run: CliRun): string => run.stdout.trim() || run.stderr.trim();

// stderr comes first: partial stdout must never hide the error that explains the exit.
export const cliFailureText = (run: CliRun): string =>
  [run.stderr.trim(), run.stdout.trim()].filter((text) => text !== "").join("\n");

export const containsAny = (text: string, markers: ReadonlyArray<string>): boolean => {
  const lowercase = text.toLowerCase();
  return markers.some((marker) => lowercase.includes(marker));
};

export const nonBlankLines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

// A CLI that is missing, fails to start, or times out has no lines.
export const runCliLines = (request: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
}): Effect.Effect<ReadonlyArray<string>> =>
  runCli(request).pipe(
    Effect.map((run) => nonBlankLines(`${run.stdout}\n${run.stderr}`)),
    Effect.orElseSucceed(() => []),
  );

export const dedupe = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const trimmedNames = names.map((name) => name.trim());
  const uniqueNames = new Set(trimmedNames);
  return [...uniqueNames].filter((name) => name !== "");
};
