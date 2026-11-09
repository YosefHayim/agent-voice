import { runDictationWorker } from "#src/dictation/dictation-worker.js";
import { runSpeechWorker } from "#src/speech/speech-worker.js";
import { type CommandSpec, readRequiredPositional } from "./command-spec.js";

const DICTATION_WORKER = "dictation";
const SPEECH_WORKER = "speech";

export const workerCommand: CommandSpec = {
  name: "worker",
  description: "Internal: run a background worker in this process (agent-voice on starts them)",
  flags: {},
  positionals: [
    {
      name: "kind",
      description: "Which worker to run",
      isRequired: true,
      choices: [DICTATION_WORKER, SPEECH_WORKER],
    },
  ],
  run: async (parsedCommand) => {
    const workerKind = readRequiredPositional(parsedCommand, "kind");
    const isDictationWorker = workerKind === DICTATION_WORKER;
    if (isDictationWorker) {
      await runDictationWorker();
      return 0;
    }

    await runSpeechWorker();
    return 0;
  },
};
