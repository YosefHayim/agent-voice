import { describeError } from "#src/error-message.js";
import { refinePrompt } from "#src/refine/refine-attempts.js";
import { readSettings, readSettingsOrDefaults, saveSettings } from "#src/settings/config-file.js";
import { sleep } from "#src/sleep.js";
import { isSpeaking, queueReply } from "#src/speech/inbox.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import { stopSpeech } from "#src/workers/worker-processes.js";
import type { StatusWriter } from "#src/workers/worker-status.js";
import { readClipboard, writeClipboard } from "./caret.js";
import type { DictationQueue } from "./dictation-queue.js";
import {
  classifyTap,
  HOLD_THRESHOLD_MS,
  type HoldAction,
  type HoldEvent,
  type HoldStatus,
  holdTransition,
  initialHoldTracker,
  readDoubleTapAction,
  sampleHold,
} from "./hold-key.js";
import type { Keyboard } from "./keyboard.js";
import type { LiveCaption } from "./live-preview.js";
import type { ClipBuffer } from "./microphone.js";

const WAITING_HOLD_STATUS = "waiting";

const LISTENING_STAGE = "listening";

const FINISHING_STAGE = "finishing";

const DONE_STAGE = "done";

const SPEECH_STOPPED_DETAIL = "Speech stopped";

const INACTIVE_STAGE = "inactive";

// The clipboard refine's outcome stays on the pill for a few seconds.
const clipboardVerdictHoldMilliseconds = 4_000;

const stopTappedSpeech = (status: StatusWriter): void => {
  const wasSpeaking = isSpeaking();
  stopSpeech();

  const wasNotSpeaking = !wasSpeaking;
  if (wasNotSpeaking) {
    return;
  }

  status.write(INACTIVE_STAGE, SPEECH_STOPPED_DETAIL);
};

interface ClipboardRefineRequest {
  readonly status: StatusWriter;
  readonly shutdown: AbortSignal;
}

// Never rejects: a failed refine is shown on the pill.
const refineCopiedPrompt = async (request: ClipboardRefineRequest): Promise<void> => {
  try {
    const settings = readSettingsOrDefaults();
    const model = settings.refineModel || "default model";
    request.status.write("refining", `Refining copied prompt (${settings.refineProvider}/${model})…`);

    const draft = await readClipboard();
    const refinedPrompt = await refinePrompt({
      draft,
      provider: settings.refineProvider,
      model: settings.refineModel || "",
      effort: settings.refineEffort || "",
      allowPicker: true,
      signal: request.shutdown,
      log: appendDictationLog,
    });
    await writeClipboard(refinedPrompt);
    request.status.write(DONE_STAGE, "Refined prompt copied — press ⌘V to paste");

    const isSpeechOff = settings.speechMode === "off";
    if (isSpeechOff) {
      return;
    }

    queueReply({ markdown: refinedPrompt, source: "refine", agentReplyId: "", origin: { kind: "terminal" } });
  } catch (error) {
    request.status.write(DONE_STAGE, `Refine failed: ${describeError(error)}`);
  }
};

const refineClipboard = async (request: ClipboardRefineRequest): Promise<void> => {
  await refineCopiedPrompt(request);
  await sleep(clipboardVerdictHoldMilliseconds);
  request.status.write(INACTIVE_STAGE, "");
};

const toggleSpeechMute = (status: StatusWriter): void => {
  try {
    const settings = readSettings();
    const willBeMuted = !settings.speechMuted;
    saveSettings({ ...settings, speechMuted: willBeMuted });

    const isNotGoingToMute = !willBeMuted;
    if (isNotGoingToMute) {
      status.write(INACTIVE_STAGE, "Speech unmuted");
      return;
    }

    // A reply can be mid-claim, with no .speaking file yet, so the double tap did not count as stopping speech.
    stopSpeech();
    status.write(INACTIVE_STAGE, "Speech muted (double-tap Shift to unmute)");
  } catch (error) {
    status.write(INACTIVE_STAGE, `Mute failed: ${describeError(error)}`);
  }
};

export const makeHoldController = (request: {
  readonly keyboard: Keyboard;
  readonly clip: ClipBuffer;
  readonly caption: LiveCaption;
  readonly status: StatusWriter;
  readonly queue: DictationQueue;
  readonly shutdown: AbortSignal;
}) => {
  const { keyboard, clip, caption, status, queue, shutdown } = request;
  let tracker = initialHoldTracker;
  let holdStatus: HoldStatus = "idle";
  let deadline: number | null = null;
  let generation = 0;
  let lastTapAt: number | null = null;
  let isListeningAnnounced = false;
  let finishingGeneration: number | null = null;

  const cancelClip = (): void => {
    clip.cancel();
    caption.clear();

    const isListeningNotAnnounced = !isListeningAnnounced;
    if (isListeningNotAnnounced) {
      return;
    }

    status.write(INACTIVE_STAGE, "");
    isListeningAnnounced = false;
  };

  // The queue never blocks the next hold.
  const endClip = (clipGeneration: number): void => {
    finishingGeneration = null;
    const samples = clip.end();
    const fallbackCaption = caption.take();

    const isClipEmpty = samples.length === 0 && fallbackCaption === "";
    if (isClipEmpty) {
      status.write(INACTIVE_STAGE, "No audio captured");
      return;
    }

    status.write(FINISHING_STAGE, `${String(samples.length)} samples`);
    queue.offer({ samples, fallbackCaption, generation: clipGeneration });
  };

  // Keeps listening after release so the last word is not clipped, unless a newer hold already took over.
  const endClipAfterKeepListening = (clipGeneration: number): void => {
    const settings = readSettingsOrDefaults();
    const millisecondsPerSecond = 1_000;

    const keepListeningMs = Math.round(settings.dictationKeepListeningSeconds * millisecondsPerSecond);
    setTimeout(() => {
      const isNewerHoldActive = finishingGeneration !== clipGeneration;
      if (isNewerHoldActive) {
        return;
      }

      endClip(clipGeneration);
    }, keepListeningMs);
  };

  const runTapAction = (): void => {
    const isRightOptionHold = keyboard.holdKey === "right-option";
    if (isRightOptionHold) {
      return;
    }

    const nowMilliseconds = Date.now();
    const tap = classifyTap({ lastTapAt, now: nowMilliseconds });
    lastTapAt = tap.rememberedTapAt;

    const isSingleTap = !tap.double;
    if (isSingleTap) {
      stopTappedSpeech(status);
      return;
    }

    const settings = readSettingsOrDefaults();
    const isClipboardRefineOn = settings.refineMode === "clipboard" || settings.refineMode === "both";
    const isSpeakingNow = isSpeaking();
    const action = readDoubleTapAction({ isSpeaking: isSpeakingNow, clipboardRefine: isClipboardRefineOn });
    switch (action) {
      case "stopSpeaking":
        stopSpeech();
        status.write(INACTIVE_STAGE, SPEECH_STOPPED_DETAIL);
        return;
      case "refineClipboard":
        // Runs in the background so the poll keeps sampling the key. refineClipboard never rejects.
        void refineClipboard({ status, shutdown });
        return;
      case "toggleMute":
        toggleSpeechMute(status);
        return;
    }
  };

  const beginListening = (): void => {
    const isSpeechPlaying = isSpeaking();
    if (isSpeechPlaying) {
      stopSpeech();
    }

    const isNotRecording = !clip.isRecording();
    if (isNotRecording) {
      clip.begin();
      caption.clear();
    }

    clip.confirm();
    status.write(LISTENING_STAGE, "Recording");
    appendDictationLog("hold start");
    isListeningAnnounced = true;
  };

  // Buffer audio before the threshold so the first word is retained.
  const scheduleHold = (): void => {
    const pendingGeneration = finishingGeneration;

    const hasPendingClip = pendingGeneration != null;
    if (hasPendingClip) {
      endClip(pendingGeneration);
    }

    deadline = Date.now() + HOLD_THRESHOLD_MS;
    generation += 1;
    clip.begin();
    caption.clear();
  };

  const stopHold = (): void => {
    isListeningAnnounced = false;
    finishingGeneration = generation;
    appendDictationLog(`hold stop gen=${String(generation)}`);
    status.write(FINISHING_STAGE, "Decoding…");
    endClipAfterKeepListening(generation);
  };

  const runHoldAction = (action: HoldAction): void => {
    switch (action) {
      case "schedule":
        scheduleHold();
        return;
      case "start":
        deadline = null;
        beginListening();
        return;
      case "cancel":
        deadline = null;
        cancelClip();
        return;
      case "tap":
        deadline = null;
        cancelClip();
        runTapAction();
        return;
      case "stop":
        stopHold();
        return;
      case "none":
        return;
    }
  };

  const applyHoldEvent = (event: HoldEvent): void => {
    const [nextHoldStatus, action] = holdTransition(holdStatus, event);
    holdStatus = nextHoldStatus;
    runHoldAction(action);
  };

  const sampleHoldEvents = (): ReadonlyArray<HoldEvent> => {
    const isHoldDown = keyboard.holdDown();
    const hold = isHoldDown ? "down" : "up";
    const [nextTracker, events] = sampleHold(tracker, { hold, otherKeys: keyboard.otherKeysDown });
    tracker = nextTracker;

    const isOtherModifierHeld = isHoldDown && keyboard.otherModifiersDown();
    if (isOtherModifierHeld) {
      return [...events, "otherDown"];
    }

    return events;
  };

  const listTimerEvents = (): ReadonlyArray<HoldEvent> => {
    const isNotHoldElapsed = deadline == null || holdStatus !== WAITING_HOLD_STATUS || Date.now() < deadline;
    if (isNotHoldElapsed) {
      return [];
    }

    return ["holdElapsed"];
  };

  // Recording with no dictation hold and no release tail means a signal was lost: never leave the mic on.
  const stopLostRecording = (): void => {
    const isHeld = holdStatus === WAITING_HOLD_STATUS || holdStatus === LISTENING_STAGE;

    const isNotLost = !clip.isRecording() || finishingGeneration != null || isHeld;
    if (isNotLost) {
      return;
    }

    appendDictationLog("recording stopped: no dictation hold");
    cancelClip();
  };

  const poll = (): void => {
    const events = [...sampleHoldEvents(), ...listTimerEvents()];
    for (const event of events) {
      applyHoldEvent(event);
    }

    stopLostRecording();
  };

  return { poll };
};
