import { Effect, Either, Option } from "effect";

import { readConfigOrDefaults } from "../settings/configFile.js";
import { appendSpeechLog } from "../workers/workerLog.js";
import { claimWorkerLock, stopRequested } from "../workers/workerProcesses.js";
import { dictationOwnsAudio } from "../workers/workerStatus.js";
import { claimNextReply, completeReply, failReply, removeInboxFiles } from "./inbox.js";
import { makeSpeechPlayer, type SpeechPlayer, speakMarkdown } from "./speechPlayer.js";
import { loadSupertonic, type SupertonicEngine } from "./supertonic.js";
import { ensureSupertonicModels } from "./supertonicModels.js";

// The dictation worker sends SIGUSR2 to stop speech now (a tap, or a new hold).
const STOP_SPEECH_SIGNAL = "SIGUSR2";

export const speakNextReply = (engine: SupertonicEngine, player: SpeechPlayer) =>
  Effect.gen(function* () {
    // Before the claim, which can wait on Cmux: a stop that comes in meanwhile must still silence the reply.
    player.reset();
    const config = yield* readConfigOrDefaults;
    // Before the dictation wait, so a reply that came in while muted is never kept for after an unmute.
    if (config.speechMuted) {
      removeInboxFiles([".json"]);
      return "wait";
    }

    if (dictationOwnsAudio()) {
      return "wait";
    }

    const next = yield* claimNextReply(config.speechMode);
    if (Option.isNone(next)) {
      return "idle";
    }

    const { file, reply } = next.value;
    const spoken = yield* speakMarkdown({
      engine,
      player,
      markdown: reply.markdown,
      voice: { voice: config.speechVoice, wordsPerMinute: config.speechWordsPerMinute },
    }).pipe(Effect.either);
    if (Either.isLeft(spoken)) {
      appendSpeechLog(`speech failed: ${String(spoken.left)}`);
      failReply(file);
      return "spoke";
    }

    completeReply(file);
    return "spoke";
  });

// Right after a reply the next one is often already queued, so look again sooner.
const pauseAfter = (step: string) => {
  if (step === "spoke") {
    return "10 millis";
  }

  return "150 millis";
};

const speakUntilStopped = (engine: SupertonicEngine, player: SpeechPlayer) =>
  Effect.gen(function* () {
    while (!stopRequested()) {
      const config = yield* readConfigOrDefaults;
      if (config.speechMode === "off") {
        removeInboxFiles([".json", ".speaking"]);
        return;
      }

      const step = yield* speakNextReply(engine, player);
      const pause = pauseAfter(step);
      yield* Effect.sleep(pause);
    }
  });

const logDownload = (file: string, bytes: number): void => {
  const megabytes = Math.round(bytes / 1e6);
  appendSpeechLog(`downloading ${file}: ${megabytes} MB`);
};

const logFailure = (failure: unknown) => Effect.sync(() => appendSpeechLog(`worker failed: ${String(failure)}`));

const loadAndSpeak = (player: SpeechPlayer) =>
  Effect.gen(function* () {
    // A claim left by a crash would otherwise look like speech in progress forever.
    removeInboxFiles([".speaking"]);
    const config = yield* readConfigOrDefaults;
    if (config.speechMode === "off") {
      removeInboxFiles([".json"]);
      return;
    }

    const folder = yield* ensureSupertonicModels(logDownload);
    const engine = yield* loadSupertonic(folder);
    appendSpeechLog(`ready pid=${process.pid}`);
    yield* speakUntilStopped(engine, player);
  });

export const runSpeechWorker = Effect.gen(function* () {
  // Installed first: the default action of SIGUSR2 would end the process while the models load.
  const player = makeSpeechPlayer();
  process.on(STOP_SPEECH_SIGNAL, player.stop);
  const hasLock = yield* claimWorkerLock("speech");
  if (!hasLock) {
    return;
  }

  yield* loadAndSpeak(player).pipe(Effect.tapError(logFailure));
}).pipe(Effect.scoped);
