import { Args, Command } from "@effect/cli";
import type { Effect } from "effect";

import { runDictationWorker } from "../dictation/dictationWorker.js";
import { runSpeechWorker } from "../speech/speechWorker.js";

type WorkerFailure = Effect.Effect.Error<typeof runDictationWorker> | Effect.Effect.Error<typeof runSpeechWorker>;

const kindArgument = Args.choice(
  [
    ["dictation", "dictation"],
    ["speech", "speech"],
  ] as const,
  { name: "kind" },
);

export const workerCommand = Command.make(
  "worker",
  { kind: kindArgument },
  (args): Effect.Effect<void, WorkerFailure> => {
    switch (args.kind) {
      case "dictation":
        return runDictationWorker;
      case "speech":
        return runSpeechWorker;
    }
  },
).pipe(Command.withDescription("Internal: run a background worker in this process (voxkey on starts them)"));
