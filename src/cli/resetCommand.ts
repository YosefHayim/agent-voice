/** `voxkey reset`: a clean slate when something is stuck: kill every voxkey worker and pill and clear the locks. */

import { Command } from "@effect/cli";
import { Effect } from "effect";

import { resetWorkers } from "../workers/workerProcesses.js";
import * as TerminalUI from "./TerminalUI.js";

export const resetCommand = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    yield* resetWorkers;
    yield* TerminalUI.success("Stopped every voxkey worker and pill and cleared the locks.");
    yield* TerminalUI.detail("Start again with `voxkey on`.");
  }),
).pipe(Command.withDescription("Kill every voxkey worker and pill and clear locks (hooks stay registered)"));
