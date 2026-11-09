import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import { runDictationWorker } from "#src/dictation/dictation-worker.js";
import { runSpeechWorker } from "#src/speech/speech-worker.js";

const kindArgument = Args.choice(
  [
    ["dictation", "dictation"],
    ["speech", "speech"],
  ] as const,
  { name: "kind" },
);

// Bridge: the workers are plain async functions; this CLI file moves off Effect in part 4.
export const workerCommand = Command.make("worker", { kind: kindArgument }, (args): Effect.Effect<void, unknown> => {
  switch (args.kind) {
    case "dictation":
      return Effect.tryPromise({ try: runDictationWorker, catch: (error) => error });
    case "speech":
      return Effect.tryPromise({ try: runSpeechWorker, catch: (error) => error });
  }
}).pipe(Command.withDescription("Internal: run a background worker in this process (agent-voice on starts them)"));
