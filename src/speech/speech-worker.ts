import { describeError } from "#src/error-message.js";
import { readSettingsOrDefaults } from "#src/settings/config-file.js";
import { sleep } from "#src/sleep.js";
import { appendSpeechLog } from "#src/workers/worker-log.js";
import { claimWorkerLock, stopRequested } from "#src/workers/worker-processes.js";
import { isAudioOwnedByDictation } from "#src/workers/worker-status.js";
import { claimNextReply, completeReply, failReply, removeInboxFiles } from "./inbox.js";
import { makeSpeechPlayer, type SpeechPlayer, speakMarkdown } from "./speech-player.js";
import { loadSupertonic, type SupertonicEngine } from "./supertonic.js";
import { ensureSupertonicModels } from "./supertonic-models.js";

type SpeakStep = "wait" | "idle" | "spoke";

// Right after a reply the next one is often already queued, so look again sooner.
const spokeStepPauseMilliseconds = 10;
const nothingSpokenPauseMilliseconds = 150;

// Reads the next reply and speaks it. Returns "wait" while muted or while the dictation owns the audio.
export const speakNextReply = async (engine: SupertonicEngine, player: SpeechPlayer): Promise<SpeakStep> => {
  // Before the claim, which can wait on Cmux: a stop that comes in meanwhile must still silence the reply.
  player.reset();

  const settings = readSettingsOrDefaults();

  // Before the dictation wait, so a reply that came in while muted is never kept for after an unmute.
  if (settings.speechMuted) {
    removeInboxFiles([".json"]);
    return "wait";
  }

  const isDictationOwningAudio = isAudioOwnedByDictation();
  if (isDictationOwningAudio) {
    return "wait";
  }

  const nextReply = await claimNextReply(settings.speechMode);

  const isThereNoNext = nextReply == null;
  if (isThereNoNext) {
    return "idle";
  }

  const { file, reply } = nextReply;
  try {
    await speakMarkdown({
      engine,
      player,
      markdown: reply.markdown,
      voice: { voice: settings.speechVoice, wordsPerMinute: settings.speechWordsPerMinute },
    });
  } catch (error) {
    appendSpeechLog(`speech failed: ${describeError(error)}`);
    failReply(file);
    return "spoke";
  }

  completeReply(file);
  return "spoke";
};

const pauseAfter = (step: SpeakStep): number => {
  const isSpokeStep = step === "spoke";
  if (isSpokeStep) {
    return spokeStepPauseMilliseconds;
  }

  return nothingSpokenPauseMilliseconds;
};

const speakUntilStopped = async (engine: SupertonicEngine, player: SpeechPlayer): Promise<void> => {
  while (!stopRequested()) {
    const settings = readSettingsOrDefaults();

    const isSpeechOff = settings.speechMode === "off";
    if (isSpeechOff) {
      removeInboxFiles([".json", ".speaking"]);
      return;
    }

    const step = await speakNextReply(engine, player);
    await sleep(pauseAfter(step));
  }
};

const logDownload = (file: string, bytes: number): void => {
  const megabytes = Math.round(bytes / 1e6);
  appendSpeechLog(`downloading ${file}: ${megabytes} MB`);
};

const loadAndSpeak = async (player: SpeechPlayer): Promise<void> => {
  // A claim left by a crash would otherwise look like speech in progress forever.
  removeInboxFiles([".speaking"]);
  const settings = readSettingsOrDefaults();

  const isSpeechOff = settings.speechMode === "off";
  if (isSpeechOff) {
    removeInboxFiles([".json"]);
    return;
  }

  const modelFolder = await ensureSupertonicModels(logDownload);
  const engine = await loadSupertonic(modelFolder);
  appendSpeechLog(`ready pid=${process.pid}`);
  await speakUntilStopped(engine, player);
};

export const runSpeechWorker = async (): Promise<void> => {
  // Installed first: the default action of SIGUSR2 would end the process while the models load.
  // The dictation worker sends SIGUSR2 to stop speech now (a tap, or a new hold).
  const player = makeSpeechPlayer();
  process.on("SIGUSR2", player.stop);
  const releaseWorkerLock = claimWorkerLock("speech");

  const isLockTaken = releaseWorkerLock == null;
  if (isLockTaken) {
    return;
  }

  try {
    await loadAndSpeak(player);
  } catch (error) {
    appendSpeechLog(`worker failed: ${describeError(error)}`);
    throw error;
  } finally {
    releaseWorkerLock();
  }
};
