import { spawn } from "node:child_process";
import path from "node:path";

import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import { watchDevinSession } from "#src/agents/devin-watcher.js";
import { stateFolder } from "#src/settings/agent-voice-home.js";
import { makePrivateFolder } from "#src/storage/state-files.js";
import { startWorkers } from "#src/workers/worker-processes.js";
import * as TerminalUI from "./terminal-ui.js";

// A child killed by a signal exits with no code; that counts as a failure.
const killedExitCode = 1;

const runDevin = (args: ReadonlyArray<string>): Promise<number> =>
  new Promise((finishRun, failRun) => {
    const child = spawn("devin", [...args], { stdio: "inherit" });
    child.on("error", (error) => failRun(new Error(`devin: ${error.message}`, { cause: error })));
    child.on("exit", (code) => finishRun(code ?? killedExitCode));
  });

const sessionFolder = (): string => {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const devinFolder = stateFolder("devin");
  return path.join(devinFolder, stamp);
};

const devinArguments = Args.text({ name: "devin-argument" }).pipe(
  Args.repeated,
  Args.withDescription("Arguments passed to Devin; put -- before Devin flags"),
);

export const devinCommand = Command.make("devin", { devinArguments }, (args) =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("devin");
    yield* Effect.tryPromise({ try: startWorkers, catch: (error) => error });
    const folder = sessionFolder();
    // Devin writes the whole session here, so the folder is private.
    makePrivateFolder(folder);
    const exportFile = path.join(folder, "session.atif.json");
    yield* TerminalUI.detail(`Reading finished turns aloud from Devin's ATIF export (${exportFile}).`);
    const session = () => runDevin(["--export", exportFile, ...args.devinArguments]);
    const code = yield* Effect.tryPromise({
      try: () => watchDevinSession({ exportFile, session }),
      catch: (error) => error,
    });
    yield* TerminalUI.outro(`Devin exited with ${String(code)}; the watcher stopped.`);
  }),
).pipe(Command.withDescription("Run Devin and read each finished turn aloud from its official ATIF export"));
