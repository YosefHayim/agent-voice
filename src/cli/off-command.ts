import { Command } from "@effect/cli";
import { Effect } from "effect";

import { unregisterReplyHooks } from "#src/agents/hook-registration.js";
import { resetWorkers } from "#src/workers/worker-processes.js";
import { showHookChanges } from "./on-command.js";
import * as TerminalUI from "./terminal-ui.js";

export const offCommand = Command.make("off", {}, () =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("off");
    // Hooks first, so an agent turn that ends meanwhile cannot start a worker after the workers are stopped.
    yield* TerminalUI.step("Removing agent-voice's Stop hook from the agent settings");
    const changes = yield* Effect.sync(unregisterReplyHooks);
    yield* showHookChanges(changes);
    yield* TerminalUI.step("Stopping the workers and the pill");
    yield* Effect.promise(resetWorkers);
    yield* TerminalUI.outro("agent-voice is off. Your config and models stay in ~/.agent-voice.");
  }),
).pipe(
  Command.withDescription("Stop dictation and speech and remove agent-voice's agent hooks (everything else stays)"),
);
