import { resetWorkers } from "#src/workers/worker-processes.js";
import type { CommandSpec } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

export const resetCommand: CommandSpec = {
  name: "reset",
  description: "Kill every agent-voice worker and pill and clear locks (hooks stay registered)",
  flags: {},
  positionals: [],
  run: async () => {
    await resetWorkers();
    TerminalUI.printSuccess("Stopped every agent-voice worker and pill and cleared the locks.");
    TerminalUI.printDetail("Start again with `agent-voice on`.");
    return 0;
  },
};
