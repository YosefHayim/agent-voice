import { spawn } from "node:child_process";
import path from "node:path";

import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";

import { watchDevinSession } from "../agents/devinWatcher.js";
import { makePrivateFolder } from "../files/stateFiles.js";
import { stateFolder } from "../settings/agentVoiceHome.js";
import { startWorkers } from "../workers/workerProcesses.js";
import * as TerminalUI from "./TerminalUI.js";

class DevinFailed extends Schema.TaggedError<DevinFailed>()("DevinFailed", { issue: Schema.String }) {
  get message(): string {
    return `devin: ${this.issue}`;
  }
}

// A child killed by a signal exits with no code; that counts as a failure.
const exitedWith = (code: number | null) => {
  if (code === null) {
    return Effect.succeed(1);
  }

  return Effect.succeed(code);
};

const runDevin = (args: ReadonlyArray<string>) =>
  Effect.async<number, DevinFailed>((resume) => {
    const child = spawn("devin", [...args], { stdio: "inherit" });
    child.on("error", (error) => resume(new DevinFailed({ issue: error.message })));
    child.on("exit", (code) => {
      const exited = exitedWith(code);
      resume(exited);
    });
    return Effect.sync(() => child.kill("SIGTERM"));
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
    yield* startWorkers;
    const folder = sessionFolder();
    // Devin writes the whole session here, so the folder is private.
    makePrivateFolder(folder);
    const exportFile = path.join(folder, "session.atif.json");
    yield* TerminalUI.detail(`Reading finished turns aloud from Devin's ATIF export (${exportFile}).`);
    const session = runDevin(["--export", exportFile, ...args.devinArguments]);
    const code = yield* watchDevinSession({ exportFile, session });
    yield* TerminalUI.outro(`Devin exited with ${String(code)}; the watcher stopped.`);
  }),
).pipe(Command.withDescription("Run Devin and read each finished turn aloud from its official ATIF export"));
