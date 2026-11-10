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

const SPEAKING_FILE_SUFFIX = ".speaking";

const OFF_MODE = "off";

const SPOKE_STEP = "spoke";

const WAIT_STEP = "wait";

const REPLY_FILE_SUFFIX = ".json";

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
    removeInboxFiles([REPLY_FILE_SUFFIX]);
    return WAIT_STEP;
  }

  const isDictationOwningAudio = isAudioOwnedByDictation();
  if (isDictationOwningAudio) {
    return WAIT_STEP;
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
    return SPOKE_STEP;
  }

  completeReply(file);
  return SPOKE_STEP;
};

const pauseAfter = (step: SpeakStep): number => {
  const isSpokeStep = step === SPOKE_STEP;
  if (isSpokeStep) {
    return spokeStepPauseMilliseconds;
  }

  return nothingSpokenPauseMilliseconds;
};

const speakUntilStopped = async (engine: SupertonicEngine, player: SpeechPlayer): Promise<void> => {
  while (!stopRequested()) {
    const settings = readSettingsOrDefaults();

    const isSpeechOff = settings.speechMode === OFF_MODE;
    if (isSpeechOff) {
      removeInboxFiles([REPLY_FILE_SUFFIX, SPEAKING_FILE_SUFFIX]);
      return;
    }

    const step = await speakNextReply(engine, player);
    await sleep(pauseAfter(step));
  }
};

const logDownload = (file: string, bytes: number): void => {
  const bytesPerMegabyte = 1e6;

  const megabytes = Math.round(bytes / bytesPerMegabyte);
  appendSpeechLog(`downloading ${file}: ${megabytes} MB`);
};

const loadAndSpeak = async (player: SpeechPlayer): Promise<void> => {
  // A claim left by a crash would otherwise look like speech in progress forever.
  removeInboxFiles([SPEAKING_FILE_SUFFIX]);
  const settings = readSettingsOrDefaults();

  const isSpeechOff = settings.speechMode === OFF_MODE;
  if (isSpeechOff) {
    removeInboxFiles([REPLY_FILE_SUFFIX]);
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
