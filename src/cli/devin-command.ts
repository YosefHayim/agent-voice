import { spawn } from "node:child_process";
import path from "node:path";

import { watchDevinSession } from "#src/agents/devin-watcher.js";
import { readStatusFolder } from "#src/settings/agent-voice-home.js";
import { makePrivateFolder } from "#src/storage/state-files.js";
import { startWorkers } from "#src/workers/worker-processes.js";
import type { CommandSpec } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const DEVIN_EXECUTABLE = "devin";

// A child killed by a signal exits with no code; that counts as a failure.
const killedExitCode = 1;

const runDevin = (devinArguments: ReadonlyArray<string>): Promise<number> =>
  new Promise<number>((finishRun, failRun) => {
    const child = spawn(DEVIN_EXECUTABLE, [...devinArguments], { stdio: "inherit" });

    child.on("error", (error) => {
      const devinError = new Error(`devin: ${error.message}`, { cause: error });
      failRun(devinError);
    });
    child.on("exit", (code) => finishRun(code ?? killedExitCode));
  });

const readSessionFolder = (): string => {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const devinFolder = readStatusFolder(DEVIN_EXECUTABLE);
  return path.join(devinFolder, stamp);
};

export const devinCommand: CommandSpec = {
  name: DEVIN_EXECUTABLE,
  description: "Run Devin and read each finished turn aloud from its official ATIF export",
  flags: {},
  positionals: [],
  isPassthrough: true,
  run: async (parsedCommand) => {
    TerminalUI.printIntro(DEVIN_EXECUTABLE);
    await startWorkers();

    const folder = readSessionFolder();
    // Devin writes the whole session here, so the folder is private.

    makePrivateFolder(folder);

    const exportFile = path.join(folder, "session.atif.json");

    TerminalUI.printDetail(`Reading finished turns aloud from Devin's ATIF export (${exportFile}).`);

    const devinArguments = ["--export", exportFile, ...parsedCommand.extraArguments];
    const readSession = () => runDevin(devinArguments);
    const exitCode = await watchDevinSession({ exportFile, readSession: readSession });

    TerminalUI.printOutro(`Devin exited with ${String(exitCode)}; the watcher stopped.`);

    return 0;
  },
};
