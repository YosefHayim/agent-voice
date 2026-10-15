/**
 * Hold-Shift decisions. Shift is also a typing key, so a press only becomes dictation after it
 * is held alone past the threshold; any other key pressed meanwhile makes it a shortcut.
 */

export type HoldState = "idle" | "waiting" | "shortcut" | "listening";

export type HoldEvent = "shiftDown" | "shiftUp" | "otherDown" | "holdElapsed";

export type HoldAction = "none" | "schedule" | "cancel" | "tap" | "start" | "stop";

/** Longer than the Shift press for a capital letter; the mic buffer already started at Shift down. */
export const HOLD_THRESHOLD_MS = 300;

/** Max gap between two taps for a double tap. */
export const DOUBLE_TAP_MS = 400;

/** How often Shift is sampled. */
export const SHIFT_POLL_MS = 8;

const waitingTransition = (event: HoldEvent): readonly [HoldState, HoldAction] => {
  switch (event) {
    case "shiftUp":
      return ["idle", "tap"];
    case "otherDown":
      return ["shortcut", "cancel"];
    case "holdElapsed":
      return ["listening", "start"];
    case "shiftDown":
      return ["waiting", "none"];
  }
};

// A slow capital letter can outlast the threshold: a key pressed while listening drops the clip.
const listeningTransition = (event: HoldEvent): readonly [HoldState, HoldAction] => {
  switch (event) {
    case "otherDown":
      return ["shortcut", "cancel"];
    case "shiftUp":
      return ["idle", "stop"];
    case "shiftDown":
    case "holdElapsed":
      return ["listening", "none"];
  }
};

export const holdTransition = (state: HoldState, event: HoldEvent): readonly [HoldState, HoldAction] => {
  switch (state) {
    case "idle":
      return event === "shiftDown" ? ["waiting", "schedule"] : [state, "none"];
    case "waiting":
      return waitingTransition(event);
    case "shortcut":
      return event === "shiftUp" ? ["idle", "none"] : [state, "none"];
    case "listening":
      return listeningTransition(event);
  }
};

/**
 * True when a key went down after Shift did. Keys already held at Shift down do not count:
 * macOS can report a key as held forever (seen with key code 0), which would cancel every hold.
 */
export const newlyPressed = (heldAtShiftDown: bigint, heldNow: bigint): boolean => (heldNow & ~heldAtShiftDown) !== 0n;

type ShiftDebounce = { readonly isDown: boolean; readonly downStreak: number; readonly upStreak: number };

export const initialShiftDebounce: ShiftDebounce = { isDown: false, downStreak: 0, upStreak: 0 };

/**
 * Debounce both edges (2 samples down ≈ 16 ms, 4 samples up ≈ 32 ms), so HID blips or another app
 * probing modifiers never end a real hold mid-recording.
 */
export const debounceShift = (
  debounce: ShiftDebounce,
  sample: "down" | "up",
): readonly [ShiftDebounce, "shiftDown" | "shiftUp" | "none"] => {
  const downStreak = sample === "down" ? debounce.downStreak + 1 : 0;
  const upStreak = sample === "down" ? 0 : debounce.upStreak + 1;
  if (downStreak >= 2 && !debounce.isDown) {
    return [{ isDown: true, downStreak, upStreak }, "shiftDown"];
  }

  if (upStreak >= 4 && debounce.isDown) {
    return [{ isDown: false, downStreak, upStreak }, "shiftUp"];
  }

  return [{ isDown: debounce.isDown, downStreak, upStreak }, "none"];
};

type ShiftTracker = { readonly debounce: ShiftDebounce; readonly heldAtShiftDown: bigint };

export const initialShiftTracker: ShiftTracker = { debounce: initialShiftDebounce, heldAtShiftDown: 0n };

/**
 * One keyboard sample → hold events. The keys held when Shift first reads down are the baseline, so a key pressed
 * while the down edge is still debouncing counts as typing; once Shift reads up no key counts, so typing right
 * after a release never cancels the clip. A key released during the hold counts again if pressed again.
 */
export const sampleShift = (
  tracker: ShiftTracker,
  sample: { readonly shift: "down" | "up"; readonly otherKeys: () => bigint },
): readonly [ShiftTracker, ReadonlyArray<HoldEvent>] => {
  const [debounce, edge] = debounceShift(tracker.debounce, sample.shift);
  if (sample.shift === "up") {
    return [{ debounce, heldAtShiftDown: tracker.heldAtShiftDown }, edge === "shiftUp" ? ["shiftUp"] : []];
  }

  const held = sample.otherKeys();
  const pressStarts = !tracker.debounce.isDown && tracker.debounce.downStreak === 0;
  const baseline = pressStarts ? held : tracker.heldAtShiftDown;
  const typed = newlyPressed(baseline, held);
  const next = { debounce, heldAtShiftDown: baseline & held };
  if (edge === "shiftDown") {
    return [next, typed ? ["shiftDown", "otherDown"] : ["shiftDown"]];
  }

  return [next, debounce.isDown && typed ? ["otherDown"] : []];
};

export type TapAction = "stopSpeaking" | "refineClipboard" | "toggleMute";

/** A double tap stops speech first; otherwise it refines the clipboard (clipboard refine) or toggles the mute. */
export const doubleTapAction = (request: {
  readonly isSpeaking: boolean;
  readonly clipboardRefine: boolean;
}): TapAction => {
  if (request.isSpeaking) {
    return "stopSpeaking";
  }

  return request.clipboardRefine ? "refineClipboard" : "toggleMute";
};

/** Whether this tap completes a double tap, and the tap time to remember for the next one. */
export const classifyTap = (request: {
  readonly lastTapAt: number | undefined;
  readonly now: number;
}): { readonly double: boolean; readonly rememberedTapAt: number | undefined } => {
  const double = request.lastTapAt !== undefined && request.now - request.lastTapAt <= DOUBLE_TAP_MS;
  return { double, rememberedTapAt: double ? undefined : request.now };
};
