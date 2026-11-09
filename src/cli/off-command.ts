import { unregisterReplyHooks } from "#src/agents/hook-registration.js";
import { resetWorkers } from "#src/workers/worker-processes.js";
import type { CommandSpec } from "./command-spec.js";
import { printHookChanges } from "./on-command.js";
import * as TerminalUI from "./terminal-ui.js";

export const offCommand: CommandSpec = {
  name: "off",
  description: "Stop dictation and speech and remove agent-voice's agent hooks (everything else stays)",
  flags: {},
  positionals: [],
  run: async () => {
    TerminalUI.printIntro("off");
    // Hooks first, so an agent turn that ends meanwhile cannot start a worker after the workers are stopped.
    TerminalUI.printStep("Removing agent-voice's Stop hook from the agent settings");
    const changes = unregisterReplyHooks();
    printHookChanges(changes);

    TerminalUI.printStep("Stopping the workers and the pill");
    await resetWorkers();
    TerminalUI.printOutro("agent-voice is off. Your config and models stay in ~/.agent-voice.");
    return 0;
  },
};
