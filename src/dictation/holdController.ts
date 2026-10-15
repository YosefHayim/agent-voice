/**
 * Turns the 8 ms Shift samples into dictation: feed debounced edges and "another key" events to the pure
 * hold table, and carry out its actions on the clip buffer, the queue, the pill, and speech.
 */

import { Duration, Effect } from "effect";
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

/** Stop speech in the speech worker; true when something was being spoken. */
const stopSpeaking = (): boolean => {
  const speaking = isSpeaking();
  stopSpeech();
  return speaking;
};

/** Double-tap Shift in clipboard refine mode: refine the copied prompt, copy it back, and read it aloud. */
const refineClipboard = (status: StatusWriter) =>
  Effect.gen(function* () {
    const config = yield* readConfigOrDefaults;
    status.write(
      "refining",
      `Refining copied prompt (${config.refineProvider}/${config.refineModel || "default model"})…`,
    );
    const refined = yield* refinePrompt({
      draft: yield* readClipboard,
      provider: config.refineProvider,
      model: config.refineModel || "",
      effort: config.refineEffort || "",
      allowPicker: true,
      log: appendDictationLog,
    });
    yield* writeClipboard(refined);
    status.write("done", "Refined prompt copied — press ⌘V to paste");
    if (config.speechMode !== "off") {
      queueReply({ markdown: refined, source: "refine", agentReplyId: "", origin: { kind: "terminal" } });
    }
  }).pipe(
    Effect.catchAll((failure) => Effect.sync(() => status.write("done", `Refine failed: ${failure.message}`))),
    Effect.zipRight(Effect.sleep("4 seconds")),
    Effect.zipRight(Effect.sync(() => status.write("inactive", ""))),
  );

/** Double-tap Shift outside clipboard refine mode: flip `speech-muted` in config.json. */
const toggleSpeechMute = (status: StatusWriter) =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    const muted = !config.speechMuted;
    yield* saveConfig({ ...config, speechMuted: muted });
    // A reply can be mid-claim, with no .speaking file yet, so the double tap did not count as stopping speech.
    if (muted) {
      stopSpeech();
    }
    status.write("inactive", muted ? "Speech muted (double-tap Shift to unmute)" : "Speech unmuted");
  }).pipe(Effect.catchAll((failure) => Effect.sync(() => status.write("inactive", `Mute failed: ${failure.message}`))));

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
    if (announcedListening) {
      status.write("inactive", "");
      announcedListening = false;
    }
  };

  /** Freeze the samples and enqueue them; the queue never blocks the next hold. */
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

  /** Keep listening after release so the last word is not clipped, unless a newer hold already took over. */
  const finishClip = (clipGeneration: number) =>
    Effect.gen(function* () {
      const config = yield* readConfigOrDefaults;
      yield* Effect.sleep(Duration.millis(Math.round(config.dictationKeepListeningSeconds * 1_000)));
      if (finishing === clipGeneration) {
        yield* endClip(clipGeneration);
      }
    });

  const onTap = Effect.gen(function* () {
    const now = Date.now();
    const tap = classifyTap({ lastTapAt, now });
    lastTapAt = tap.rememberedTapAt;
    if (!tap.double) {
      if (stopSpeaking()) {
        status.write("inactive", "Speech stopped");
      }
      return;
    }

    const config = yield* readConfigOrDefaults;
    const clipboardRefine = config.refineMode === "clipboard" || config.refineMode === "both";
    switch (doubleTapAction({ isSpeaking: isSpeaking(), clipboardRefine })) {
      case "stopSpeaking":
        stopSpeaking();
        status.write("inactive", "Speech stopped");
        return;
      case "refineClipboard":
        yield* Effect.forkDaemon(refineClipboard(status));
        return;
      case "toggleMute":
        yield* toggleSpeechMute(status);
        return;
    }
  });

  const startListening = Effect.sync(() => {
    if (isSpeaking()) {
      stopSpeaking();
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
        return Effect.zipRight(Effect.sync(cancelClip), onTap);
      case "stop":
        announcedListening = false;
        finishing = generation;
        appendDictationLog(`hold stop gen=${String(generation)}`);
        status.write("finishing", "Decoding…");
        return Effect.asVoid(Effect.fork(finishClip(generation)));
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
    const [next, events] = sampleShift(tracker, {
      shift: keyboard.shiftDown() ? "down" : "up",
      otherKeys: keyboard.otherKeysDown,
    });
    tracker = next;
    return events;
  };

  const timerEvents = (): ReadonlyArray<HoldEvent> =>
    deadline !== undefined && state === "waiting" && Date.now() >= deadline ? ["holdElapsed"] : [];

  // Recording with no Shift hold and no release tail means a signal was lost: never leave the mic on.
  const safetyNet = Effect.sync(() => {
    if (clip.isRecording() && finishing === undefined && (state === "idle" || state === "shortcut")) {
      appendDictationLog("recording stopped: no Shift hold");
      cancelClip();
    }
  });

  /** One 8 ms sample of the keyboard. */
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    Effect.zipRight(Effect.forEach([...sampleEvents(), ...timerEvents()], apply, { discard: true }), safetyNet),
  );

  return { poll };
};
