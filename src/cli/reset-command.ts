import { Command } from "@effect/cli";
import { Effect } from "effect";

import { resetWorkers } from "../workers/worker-processes.js";
import * as TerminalUI from "./terminal-ui.js";

export const resetCommand = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    yield* resetWorkers;
    yield* TerminalUI.success("Stopped every agent-voice worker and pill and cleared the locks.");
    yield* TerminalUI.detail("Start again with `agent-voice on`.");
  }),
).pipe(Command.withDescription("Kill every agent-voice worker and pill and clear locks (hooks stay registered)"));
