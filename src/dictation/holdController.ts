// Turns the 8 ms Shift samples into dictation: debounced edges and "another key" events go to the pure hold
// table, and its actions run on the clip buffer, the queue, the pill, and speech.

import { Effect } from "effect";
import { refinePrompt } from "../refine/refineAttempts.js";
import { readConfig, readConfigOrDefaults, saveConfig } from "../settings/configFile.js";
import { isSpeaking, queueReply } from "../speech/inbox.js";
import { appendDictationLog } from "../workers/workerLog.js";
import { stopSpeech } from "../workers/workerProcesses.js";
import type { StatusWriter } from "../workers/workerStatus.js";
import { readClipboard, writeClipboard } from "./caret.js";
import type { DictationQueue } from "./dictationQueue.js";
import {
  classifyTap,
  doubleTapAction,
  HOLD_THRESHOLD_MS,
  type HoldAction,
  type HoldEvent,
  type HoldState,
  holdTransition,
  initialShiftTracker,
  sampleShift,
} from "./holdKey.js";
import type { Keyboard } from "./keyboard.js";
import type { LiveCaption } from "./livePreview.js";
import type { ClipBuffer } from "./microphone.js";

const stopTappedSpeech = (status: StatusWriter) => {
  const wasSpeaking = isSpeaking();
  stopSpeech();
  if (!wasSpeaking) {
    return;
  }

  status.write("inactive", "Speech stopped");
};

const refineCopiedPrompt = (status: StatusWriter) =>
  Effect.gen(function* () {
    const config = yield* readConfigOrDefaults;
    const model = config.refineModel || "default model";
    status.write("refining", `Refining copied prompt (${config.refineProvider}/${model})…`);
    const draft = yield* readClipboard;
    const refined = yield* refinePrompt({
      draft,
      provider: config.refineProvider,
      model: config.refineModel || "",
      effort: config.refineEffort || "",
      allowPicker: true,
      log: appendDictationLog,
    });
    yield* writeClipboard(refined);
    status.write("done", "Refined prompt copied — press ⌘V to paste");
    if (config.speechMode === "off") {
      return;
    }

    queueReply({ markdown: refined, source: "refine", agentReplyId: "", origin: { kind: "terminal" } });
  }).pipe(Effect.catchAll((failure) => Effect.sync(() => status.write("done", `Refine failed: ${failure.message}`))));

// The outcome stays on the pill for a few seconds.
const refineClipboard = (status: StatusWriter) =>
  Effect.gen(function* () {
    yield* refineCopiedPrompt(status);
    yield* Effect.sleep("4 seconds");
    status.write("inactive", "");
  });

const toggleSpeechMute = (status: StatusWriter) =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    const muted = !config.speechMuted;
    yield* saveConfig({ ...config, speechMuted: muted });
    if (!muted) {
      status.write("inactive", "Speech unmuted");
      return;
    }

    // A reply can be mid-claim, with no .speaking file yet, so the double tap did not count as stopping speech.
    stopSpeech();
    status.write("inactive", "Speech muted (double-tap Shift to unmute)");
  }).pipe(Effect.catchAll((failure) => Effect.sync(() => status.write("inactive", `Mute failed: ${failure.message}`))));

const shiftSample = (keyboard: Keyboard): "down" | "up" => {
  if (keyboard.shiftDown()) {
    return "down";
  }

  return "up";
};

export const makeHoldController = (request: {
  readonly keyboard: Keyboard;
  readonly clip: ClipBuffer;
  readonly caption: LiveCaption;
  readonly status: StatusWriter;
  readonly queue: DictationQueue;
}) => {
  const { keyboard, clip, caption, status, queue } = request;
  let tracker = initialShiftTracker;
  let state: HoldState = "idle";
  let deadline: number | undefined;
  let generation = 0;
  let lastTapAt: number | undefined;
  let announcedListening = false;
  let finishing: number | undefined;

  const cancelClip = () => {
    clip.cancel();
    caption.clear();
    if (!announcedListening) {
      return;
    }

    status.write("inactive", "");
    announcedListening = false;
  };

  // The queue never blocks the next hold.
  const endClip = (clipGeneration: number) =>
    Effect.suspend(() => {
      finishing = undefined;
      const samples = clip.end();
      const fallbackCaption = caption.take();
      if (samples.length === 0 && fallbackCaption === "") {
        status.write("inactive", "No audio captured");
        return Effect.void;
      }

      status.write("finishing", `${String(samples.length)} samples`);
      return queue.offer({ samples, fallbackCaption, generation: clipGeneration });
    });

  // Keeps listening after release so the last word is not clipped, unless a newer hold already took over.
  const finishClip = (clipGeneration: number) =>
    Effect.gen(function* () {
      const config = yield* readConfigOrDefaults;
      const keepListeningMs = Math.round(config.dictationKeepListeningSeconds * 1_000);
      yield* Effect.sleep(keepListeningMs);
      if (finishing !== clipGeneration) {
        return;
      }

      yield* endClip(clipGeneration);
    });

  const onTap = Effect.gen(function* () {
    const tap = classifyTap({ lastTapAt, now: Date.now() });
    lastTapAt = tap.rememberedTapAt;
    if (!tap.double) {
      stopTappedSpeech(status);
      return;
    }

    const config = yield* readConfigOrDefaults;
    const clipboardRefine = config.refineMode === "clipboard" || config.refineMode === "both";
    const action = doubleTapAction({ isSpeaking: isSpeaking(), clipboardRefine });
    switch (action) {
      case "stopSpeaking":
        stopSpeech();
        status.write("inactive", "Speech stopped");
        return;
      case "refineClipboard":
        yield* refineClipboard(status).pipe(Effect.forkDaemon);
        return;
      case "toggleMute":
        yield* toggleSpeechMute(status);
        return;
    }
  });

  const startListening = Effect.sync(() => {
    if (isSpeaking()) {
      stopSpeech();
    }
    if (!clip.isRecording()) {
      clip.begin();
      caption.clear();
    }
    clip.confirm();
    status.write("listening", "Recording");
    appendDictationLog("hold start");
    announcedListening = true;
  });

  // Shift is also pressed for every capital letter, so Shift down only opens the buffer (and ends a clip
  // still in its release tail); the pill waits until the hold is confirmed.
  const schedule = Effect.gen(function* () {
    if (finishing !== undefined) {
      yield* endClip(finishing);
    }
    deadline = Date.now() + HOLD_THRESHOLD_MS;
    generation += 1;
    clip.begin();
    caption.clear();
  });

  const perform = (action: HoldAction): Effect.Effect<void> => {
    switch (action) {
      case "schedule":
        return schedule;
      case "start":
        deadline = undefined;
        return startListening;
      case "cancel":
        deadline = undefined;
        return Effect.sync(cancelClip);
      case "tap":
        deadline = undefined;
        return Effect.sync(cancelClip).pipe(Effect.zipRight(onTap));
      case "stop":
        announcedListening = false;
        finishing = generation;
        appendDictationLog(`hold stop gen=${String(generation)}`);
        status.write("finishing", "Decoding…");
        return finishClip(generation).pipe(Effect.fork, Effect.asVoid);
      case "none":
        return Effect.void;
    }
  };

  const apply = (event: HoldEvent) =>
    Effect.suspend(() => {
      const [next, action] = holdTransition(state, event);
      state = next;
      return perform(action);
    });

  // Shift plus another key is typing or a shortcut, never a hold.
  const sampleEvents = (): ReadonlyArray<HoldEvent> => {
    const shift = shiftSample(keyboard);
    const [next, events] = sampleShift(tracker, { shift, otherKeys: keyboard.otherKeysDown });
    tracker = next;
    return events;
  };

  const timerEvents = (): ReadonlyArray<HoldEvent> => {
    const isHoldElapsed = deadline !== undefined && state === "waiting" && Date.now() >= deadline;
    if (!isHoldElapsed) {
      return [];
    }

    return ["holdElapsed"];
  };

  // Recording with no Shift hold and no release tail means a signal was lost: never leave the mic on.
  const safetyNet = Effect.sync(() => {
    const isHeld = state === "waiting" || state === "listening";
    const isLost = clip.isRecording() && finishing === undefined && !isHeld;
    if (!isLost) {
      return;
    }

    appendDictationLog("recording stopped: no Shift hold");
    cancelClip();
  });

  const poll: Effect.Effect<void> = Effect.gen(function* () {
    const events = [...sampleEvents(), ...timerEvents()];
    yield* Effect.forEach(events, apply, { discard: true });
    yield* safetyNet;
  });

  return { poll };
};
