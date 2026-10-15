/**
 * The speech worker (`voxkey worker speech`): inbox → Supertonic → afplay, in its own process so
 * speech never competes with the Shift poller. It exits when speech is turned off.
 */

import { Effect, Option } from "effect";

import { readConfigOrDefaults } from "../settings/configFile.js";
import { appendSpeechLog } from "../workers/workerLog.js";
import { claimWorkerLock, stopRequested } from "../workers/workerProcesses.js";
import { dictationOwnsAudio } from "../workers/workerStatus.js";
import { claimNextReply, completeReply, failReply, removeInboxFiles } from "./inbox.js";
import { makeSpeechPlayer, speakMarkdown } from "./speechPlayer.js";
import { loadSupertonic, type SupertonicEngine } from "./supertonic.js";
import { ensureSupertonicModels } from "./supertonicModels.js";

/** The dictation worker sends SIGUSR2 to stop speech now (a tap, or a new hold). */
const STOP_SPEECH_SIGNAL = "SIGUSR2";

export const speakNextReply = (engine: SupertonicEngine, player: ReturnType<typeof makeSpeechPlayer>) =>
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

    const spoken = yield* Effect.either(
      speakMarkdown({
        engine,
        player,
        markdown: next.value.reply.markdown,
        voice: { voice: config.speechVoice, wordsPerMinute: config.speechWordsPerMinute },
      }),
    );
    if (spoken._tag === "Right") {
      completeReply(next.value.file);
    } else {
      appendSpeechLog(`speech failed: ${String(spoken.left)}`);
      failReply(next.value.file);
    }
    return "spoke";
  });

const speakUntilStopped = (engine: SupertonicEngine, player: ReturnType<typeof makeSpeechPlayer>) =>
  Effect.gen(function* () {
    while (!stopRequested()) {
      const config = yield* readConfigOrDefaults;
      if (config.speechMode === "off") {
        removeInboxFiles([".json", ".speaking"]);
        return;
      }

      const step = yield* speakNextReply(engine, player);
      yield* Effect.sleep(step === "spoke" ? "10 millis" : "150 millis");
    }
  });

export const runSpeechWorker = Effect.gen(function* () {
  // Installed first: the default action of SIGUSR2 would end the process while the models load.
  let stopSpeech = () => {};
  process.on(STOP_SPEECH_SIGNAL, () => stopSpeech());
  if (!(yield* claimWorkerLock("speech"))) {
    return;
  }

  yield* Effect.gen(function* () {
    // A claim left by a crash would otherwise look like speech in progress forever.
    removeInboxFiles([".speaking"]);
    const config = yield* readConfigOrDefaults;
    if (config.speechMode === "off") {
      removeInboxFiles([".json"]);
      return;
    }

    const folder = yield* ensureSupertonicModels((file, bytes) =>
      appendSpeechLog(`downloading ${file}: ${String(Math.round(bytes / 1e6))} MB`),
    );
    const engine = yield* loadSupertonic(folder);
    const player = makeSpeechPlayer();
    stopSpeech = player.stop;
    appendSpeechLog(`ready pid=${String(process.pid)}`);
    yield* speakUntilStopped(engine, player);
  }).pipe(Effect.tapError((failure) => Effect.sync(() => appendSpeechLog(`worker failed: ${String(failure)}`))));
}).pipe(Effect.scoped);
