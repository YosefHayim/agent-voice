import { Effect } from "effect";
import { refinePrompt } from "../refine/refine-attempts.js";
import { readConfig, readConfigOrDefaults, saveConfig } from "../settings/config-file.js";
import { isSpeaking, queueReply } from "../speech/inbox.js";
import { appendDictationLog } from "../workers/worker-log.js";
import { stopSpeech } from "../workers/worker-processes.js";
import type { StatusWriter } from "../workers/worker-status.js";
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

const holdSample = (keyboard: Keyboard): "down" | "up" => {
  if (keyboard.holdDown()) {
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
  let tracker = initialHoldTracker;
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
    if (keyboard.holdKey === "right-option") {
      return;
    }

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

  // Buffer audio before the threshold so the first word is retained.
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

  const sampleEvents = (): ReadonlyArray<HoldEvent> => {
    const hold = holdSample(keyboard);
    const [next, events] = sampleHold(tracker, { hold, otherKeys: keyboard.otherKeysDown });
    tracker = next;
    if (hold === "down" && keyboard.otherModifiersDown()) {
      return [...events, "otherDown"];
    }

    return events;
  };

  const timerEvents = (): ReadonlyArray<HoldEvent> => {
    const isHoldElapsed = deadline !== undefined && state === "waiting" && Date.now() >= deadline;
    if (!isHoldElapsed) {
      return [];
    }

    return ["holdElapsed"];
  };

  // Recording with no dictation hold and no release tail means a signal was lost: never leave the mic on.
  const safetyNet = Effect.sync(() => {
    const isHeld = state === "waiting" || state === "listening";
    const isLost = clip.isRecording() && finishing === undefined && !isHeld;
    if (!isLost) {
      return;
    }

    appendDictationLog("recording stopped: no dictation hold");
    cancelClip();
  });

  const poll: Effect.Effect<void> = Effect.gen(function* () {
    const events = [...sampleEvents(), ...timerEvents()];
    yield* Effect.forEach(events, apply, { discard: true });
    yield* safetyNet;
  });

  return { poll };
};
