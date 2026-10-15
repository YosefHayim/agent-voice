// Shift is also a typing key, so a press becomes dictation only when it is held alone past the threshold;
// any other key pressed meanwhile makes it a shortcut.

export type HoldState = "idle" | "waiting" | "shortcut" | "listening";

export type HoldEvent = "shiftDown" | "shiftUp" | "otherDown" | "holdElapsed";

export type HoldAction = "none" | "schedule" | "cancel" | "tap" | "start" | "stop";

type HoldStep = readonly [HoldState, HoldAction];

type ShiftSample = "down" | "up";

type ShiftEdge = "shiftDown" | "shiftUp" | "none";

// Longer than the Shift press for a capital letter; the mic buffer already started at Shift down.
export const HOLD_THRESHOLD_MS = 300;

export const DOUBLE_TAP_MS = 400;

export const SHIFT_POLL_MS = 8;

const holdSteps: Record<HoldState, Record<HoldEvent, HoldStep>> = {
  idle: {
    shiftDown: ["waiting", "schedule"],
    shiftUp: ["idle", "none"],
    otherDown: ["idle", "none"],
    holdElapsed: ["idle", "none"],
  },
  waiting: {
    shiftDown: ["waiting", "none"],
    shiftUp: ["idle", "tap"],
    otherDown: ["shortcut", "cancel"],
    holdElapsed: ["listening", "start"],
  },
  shortcut: {
    shiftDown: ["shortcut", "none"],
    shiftUp: ["idle", "none"],
    otherDown: ["shortcut", "none"],
    holdElapsed: ["shortcut", "none"],
  },
  // A slow capital letter can outlast the threshold, so a key pressed while listening drops the clip.
  listening: {
    shiftDown: ["listening", "none"],
    shiftUp: ["idle", "stop"],
    otherDown: ["shortcut", "cancel"],
    holdElapsed: ["listening", "none"],
  },
};

export const holdTransition = (state: HoldState, event: HoldEvent): HoldStep => holdSteps[state][event];

// Keys already held at Shift down never count: macOS can report a key as held forever (seen with key code 0),
// which would cancel every hold.
export const newlyPressed = (heldAtShiftDown: bigint, heldNow: bigint): boolean => (heldNow & ~heldAtShiftDown) !== 0n;

type ShiftDebounce = { readonly isDown: boolean; readonly downStreak: number; readonly upStreak: number };

export const initialShiftDebounce: ShiftDebounce = { isDown: false, downStreak: 0, upStreak: 0 };

const nextStreaks = (debounce: ShiftDebounce, sample: ShiftSample) => {
  if (sample === "down") {
    return { downStreak: debounce.downStreak + 1, upStreak: 0 };
  }

  return { downStreak: 0, upStreak: debounce.upStreak + 1 };
};

// 2 samples down (about 16 ms) and 4 samples up (about 32 ms), so a HID blip or another app probing modifiers
// never ends a real hold mid-recording.
export const debounceShift = (debounce: ShiftDebounce, sample: ShiftSample): readonly [ShiftDebounce, ShiftEdge] => {
  const streaks = nextStreaks(debounce, sample);
  const isPressed = streaks.downStreak >= 2 && !debounce.isDown;
  if (isPressed) {
    return [{ isDown: true, ...streaks }, "shiftDown"];
  }

  const isReleased = streaks.upStreak >= 4 && debounce.isDown;
  if (isReleased) {
    return [{ isDown: false, ...streaks }, "shiftUp"];
  }

  return [{ isDown: debounce.isDown, ...streaks }, "none"];
};

type ShiftTracker = { readonly debounce: ShiftDebounce; readonly heldAtShiftDown: bigint };

export const initialShiftTracker: ShiftTracker = { debounce: initialShiftDebounce, heldAtShiftDown: 0n };

const edgeEvents = (edge: ShiftEdge): ReadonlyArray<HoldEvent> => {
  if (edge === "none") {
    return [];
  }

  return [edge];
};

// The keys held when Shift first reads down are the baseline, so a key pressed while the down edge still
// debounces counts as typing.
const baselineKeys = (tracker: ShiftTracker, heldNow: bigint): bigint => {
  const isPressStart = !tracker.debounce.isDown && tracker.debounce.downStreak === 0;
  if (isPressStart) {
    return heldNow;
  }

  return tracker.heldAtShiftDown;
};

// Once Shift reads up no key counts, so typing right after a release never cancels the clip.
// A key released during the hold counts again when it is pressed again.
export const sampleShift = (
  tracker: ShiftTracker,
  sample: { readonly shift: ShiftSample; readonly otherKeys: () => bigint },
): readonly [ShiftTracker, ReadonlyArray<HoldEvent>] => {
  const [debounce, edge] = debounceShift(tracker.debounce, sample.shift);
  const shiftEvents = edgeEvents(edge);
  if (sample.shift === "up") {
    return [{ debounce, heldAtShiftDown: tracker.heldAtShiftDown }, shiftEvents];
  }

  const heldNow = sample.otherKeys();
  const baseline = baselineKeys(tracker, heldNow);
  const next = { debounce, heldAtShiftDown: baseline & heldNow };
  const isTyping = debounce.isDown && newlyPressed(baseline, heldNow);
  if (!isTyping) {
    return [next, shiftEvents];
  }

  return [next, [...shiftEvents, "otherDown"]];
};

export type TapAction = "stopSpeaking" | "refineClipboard" | "toggleMute";

export const doubleTapAction = (request: {
  readonly isSpeaking: boolean;
  readonly clipboardRefine: boolean;
}): TapAction => {
  if (request.isSpeaking) {
    return "stopSpeaking";
  }

  if (request.clipboardRefine) {
    return "refineClipboard";
  }

  return "toggleMute";
};

export const classifyTap = (request: {
  readonly lastTapAt: number | undefined;
  readonly now: number;
}): { readonly double: boolean; readonly rememberedTapAt: number | undefined } => {
  const double = request.lastTapAt !== undefined && request.now - request.lastTapAt <= DOUBLE_TAP_MS;
  if (double) {
    return { double, rememberedTapAt: undefined };
  }

  return { double, rememberedTapAt: request.now };
};
