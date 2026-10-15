import { Command } from "@effect/cli";
import { Effect } from "effect";

import { unregisterReplyHooks } from "../agents/hookRegistration.js";
import { resetWorkers } from "../workers/workerProcesses.js";
import { showHookChanges } from "./onCommand.js";
import * as TerminalUI from "./TerminalUI.js";

export const offCommand = Command.make("off", {}, () =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("off");
    // Hooks first, so an agent turn that ends meanwhile cannot start a worker after the workers are stopped.
    yield* TerminalUI.step("Removing voxkey's Stop hook from the agent settings");
    const changes = yield* unregisterReplyHooks;
    yield* showHookChanges(changes);
    yield* TerminalUI.step("Stopping the workers and the pill");
    yield* resetWorkers;
    yield* TerminalUI.outro("voxkey is off. Your config and models stay in ~/.voxkey.");
  }),
).pipe(Command.withDescription("Stop dictation and speech and remove voxkey's agent hooks (everything else stays)"));
