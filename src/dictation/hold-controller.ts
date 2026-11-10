import { describeError } from "#src/error-message.js";
import { refinePrompt } from "#src/refine/refine-attempts.js";
import { readConfig, readConfigOrDefaults, saveConfig } from "#src/settings/config-file.js";
import { sleep } from "#src/sleep.js";
import { isSpeaking, queueReply } from "#src/speech/inbox.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import { stopSpeech } from "#src/workers/worker-processes.js";
import type { StatusWriter } from "#src/workers/worker-status.js";
import { readClipboard, writeClipboard } from "./caret.js";
import type { DictationQueue } from "./dictation-queue.js";
import {
  classifyTap,
  doubleTapAction,
  HOLD_THRESHOLD_MS,
  type HoldAction,
  type HoldEvent,
  type HoldState,
  holdTransition,
  initialHoldTracker,
  sampleHold,
} from "./hold-key.js";
import type { Keyboard } from "./keyboard.js";
import type { LiveCaption } from "./live-preview.js";
import type { ClipBuffer } from "./microphone.js";

// The clipboard refine's outcome stays on the pill for a few seconds.
const clipboardOutcomeHoldMilliseconds = 4_000;

const stopTappedSpeech = (status: StatusWriter): void => {
  const wasSpeaking = isSpeaking();
  stopSpeech();

  const wasNotSpeaking = !wasSpeaking;
  if (wasNotSpeaking) {
    return;
  }

  status.write("inactive", "Speech stopped");
};

interface ClipboardRefineRequest {
  readonly status: StatusWriter;
  readonly shutdown: AbortSignal;
}

// Never rejects: a failed refine is shown on the pill.
const refineCopiedPrompt = async (request: ClipboardRefineRequest): Promise<void> => {
  try {
    const settings = readConfigOrDefaults();
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
    request.status.write("done", "Refined prompt copied — press ⌘V to paste");

    const isSpeechOff = settings.speechMode === "off";
    if (isSpeechOff) {
      return;
    }

    queueReply({ markdown: refinedPrompt, source: "refine", agentReplyId: "", origin: { kind: "terminal" } });
  } catch (error) {
    request.status.write("done", `Refine failed: ${describeError(error)}`);
  }
};

const refineClipboard = async (request: ClipboardRefineRequest): Promise<void> => {
  await refineCopiedPrompt(request);
  await sleep(clipboardOutcomeHoldMilliseconds);
  request.status.write("inactive", "");
};

const toggleSpeechMute = (status: StatusWriter): void => {
  try {
    const settings = readConfig();
    const willBeMuted = !settings.speechMuted;
    saveConfig({ ...settings, speechMuted: willBeMuted });

    const isNotGoingToMute = !willBeMuted;
    if (isNotGoingToMute) {
      status.write("inactive", "Speech unmuted");
      return;
    }

    // A reply can be mid-claim, with no .speaking file yet, so the double tap did not count as stopping speech.
    stopSpeech();
    status.write("inactive", "Speech muted (double-tap Shift to unmute)");
  } catch (error) {
    status.write("inactive", `Mute failed: ${describeError(error)}`);
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
  let holdState: HoldState = "idle";
  let deadline: number | undefined;
  let generation = 0;
  let lastTapAt: number | undefined;
  let isListeningAnnounced = false;
  let finishingGeneration: number | undefined;

  const cancelClip = (): void => {
    clip.cancel();
    caption.clear();

    const isListeningNotAnnounced = !isListeningAnnounced;
    if (isListeningNotAnnounced) {
      return;
    }

    status.write("inactive", "");
    isListeningAnnounced = false;
  };

  // The queue never blocks the next hold.
  const endClip = (clipGeneration: number): void => {
    finishingGeneration = undefined;
    const samples = clip.end();
    const fallbackCaption = caption.take();

    const isClipEmpty = samples.length === 0 && fallbackCaption === "";
    if (isClipEmpty) {
      status.write("inactive", "No audio captured");
      return;
    }

    status.write("finishing", `${String(samples.length)} samples`);
    queue.offer({ samples, fallbackCaption, generation: clipGeneration });
  };

  // Keeps listening after release so the last word is not clipped, unless a newer hold already took over.
  const endClipAfterKeepListening = (clipGeneration: number): void => {
    const settings = readConfigOrDefaults();
    const keepListeningMs = Math.round(settings.dictationKeepListeningSeconds * 1_000);
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

    const tap = classifyTap({ lastTapAt, now: Date.now() });
    lastTapAt = tap.rememberedTapAt;

    const isSingleTap = !tap.double;
    if (isSingleTap) {
      stopTappedSpeech(status);
      return;
    }

    const settings = readConfigOrDefaults();
    const isClipboardRefineOn = settings.refineMode === "clipboard" || settings.refineMode === "both";
    const action = doubleTapAction({ isSpeaking: isSpeaking(), clipboardRefine: isClipboardRefineOn });
    switch (action) {
      case "stopSpeaking":
        stopSpeech();
        status.write("inactive", "Speech stopped");
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
    status.write("listening", "Recording");
    appendDictationLog("hold start");
    isListeningAnnounced = true;
  };

  // Buffer audio before the threshold so the first word is retained.
  const scheduleHold = (): void => {
    const pendingGeneration = finishingGeneration;

    const hasPendingClip = pendingGeneration !== undefined;
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
    status.write("finishing", "Decoding…");
    endClipAfterKeepListening(generation);
  };

  const runHoldAction = (action: HoldAction): void => {
    switch (action) {
      case "schedule":
        scheduleHold();
        return;
      case "start":
        deadline = undefined;
        beginListening();
        return;
      case "cancel":
        deadline = undefined;
        cancelClip();
        return;
      case "tap":
        deadline = undefined;
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
    const [nextHoldState, action] = holdTransition(holdState, event);
    holdState = nextHoldState;
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
    const isNotHoldElapsed = deadline === undefined || holdState !== "waiting" || Date.now() < deadline;
    if (isNotHoldElapsed) {
      return [];
    }

    return ["holdElapsed"];
  };

  // Recording with no dictation hold and no release tail means a signal was lost: never leave the mic on.
  const stopLostRecording = (): void => {
    const isHeld = holdState === "waiting" || holdState === "listening";

    const isNotLost = !clip.isRecording() || finishingGeneration !== undefined || isHeld;
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
