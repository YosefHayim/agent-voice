import { spawn } from "node:child_process";
import path from "node:path";
import { text } from "node:stream/consumers";

import { repositoryRoot } from "./testFolder.js";

const mainScript = path.join(repositoryRoot, "src", "cli", "main.ts");

type VoxkeyRun = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

// Runs voxkey from source without blocking: a test worker whose event loop stays busy for seconds misses vitest's
// own messages, and the run fails with "Timeout calling onTaskUpdate".
export const runVoxkey = async (request: {
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin?: string;
}): Promise<VoxkeyRun> => {
  const child = spawn(process.execPath, ["--import", "tsx", mainScript, ...request.args], {
    cwd: repositoryRoot,
    env: request.environment,
  });
  // A run that exits before reading its input closes the pipe; the exit code and output still tell the story.
  child.stdin.on("error", () => {});
  child.stdin.end(request.stdin || "");
  const stdout = text(child.stdout);
  const stderr = text(child.stderr);
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  const [stdoutText, stderrText, status] = await Promise.all([stdout, stderr, exit]);
  return { status, stdout: stdoutText, stderr: stderrText };
};
