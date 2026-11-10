export const holdKeyLabels = { shift: "Shift", "right-option": "Right Option" } as const;

export type HoldStatus = "idle" | "waiting" | "shortcut" | "listening";

export type HoldEvent = "holdDown" | "holdUp" | "otherDown" | "holdElapsed";

export type HoldAction = "none" | "schedule" | "cancel" | "tap" | "start" | "stop";

type HoldStep = readonly [HoldStatus, HoldAction];

type HoldSample = "down" | "up";

type HoldEdge = "holdDown" | "holdUp" | "none";

// The threshold distinguishes an intentional hold from a tap or a typing shortcut.
export const HOLD_THRESHOLD_MS = 300;

const DOUBLE_TAP_MS = 400;

export const HOLD_POLL_MS = 8;

const holdSteps: Record<HoldStatus, Record<HoldEvent, HoldStep>> = {
  idle: {
    holdDown: ["waiting", "schedule"],
    holdUp: ["idle", "none"],
    otherDown: ["idle", "none"],
    holdElapsed: ["idle", "none"],
  },
  waiting: {
    holdDown: ["waiting", "none"],
    holdUp: ["idle", "tap"],
    otherDown: ["shortcut", "cancel"],
    holdElapsed: ["listening", "start"],
  },
  shortcut: {
    holdDown: ["shortcut", "none"],
    holdUp: ["idle", "none"],
    otherDown: ["shortcut", "none"],
    holdElapsed: ["shortcut", "none"],
  },
  // A slow shortcut can outlast the threshold, so another key drops the clip.
  listening: {
    holdDown: ["listening", "none"],
    holdUp: ["idle", "stop"],
    otherDown: ["shortcut", "cancel"],
    holdElapsed: ["listening", "none"],
  },
};

export const holdTransition = (status: HoldStatus, event: HoldEvent): HoldStep => holdSteps[status][event];

// Keys already held when a hold begins never count: macOS can report a key as held forever (seen with key code 0),
// which would cancel every hold.
export const isNewlyPressed = (heldAtHoldDown: bigint, heldNow: bigint): boolean => (heldNow & ~heldAtHoldDown) !== 0n;

type HoldDebounce = { readonly isDown: boolean; readonly downStreak: number; readonly upStreak: number };

export const initialHoldDebounce: HoldDebounce = { isDown: false, downStreak: 0, upStreak: 0 };

const readNextStreaks = (debounce: HoldDebounce, sample: HoldSample) => {
  const isSampleDown = sample === "down";
  if (isSampleDown) {
    return { downStreak: debounce.downStreak + 1, upStreak: 0 };
  }

  return { downStreak: 0, upStreak: debounce.upStreak + 1 };
};

// 2 samples down (about 16 ms) and 4 samples up (about 32 ms), so a HID blip or another app probing modifiers
// never ends a real hold mid-recording.
export const debounceHold = (debounce: HoldDebounce, sample: HoldSample): readonly [HoldDebounce, HoldEdge] => {
  const streaks = readNextStreaks(debounce, sample);

  const isPressed = streaks.downStreak >= 2 && !debounce.isDown;
  if (isPressed) {
    return [{ isDown: true, ...streaks }, "holdDown"];
  }

  const isReleased = streaks.upStreak >= 4 && debounce.isDown;
  if (isReleased) {
    return [{ isDown: false, ...streaks }, "holdUp"];
  }

  return [{ isDown: debounce.isDown, ...streaks }, "none"];
};

type HoldTracker = { readonly debounce: HoldDebounce; readonly heldAtHoldDown: bigint };

export const initialHoldTracker: HoldTracker = { debounce: initialHoldDebounce, heldAtHoldDown: 0n };

const listEdgeEvents = (edge: HoldEdge): ReadonlyArray<HoldEvent> => {
  const isEdgeNone = edge === "none";
  if (isEdgeNone) {
    return [];
  }

  return [edge];
};

// The keys held when the hold key first reads down are the baseline, so a key pressed while the down edge still
// debounces counts as typing.
const readBaselineKeys = (tracker: HoldTracker, heldNow: bigint): bigint => {
  const isPressStart = !tracker.debounce.isDown && tracker.debounce.downStreak === 0;
  if (isPressStart) {
    return heldNow;
  }

  return tracker.heldAtHoldDown;
};

// Once the hold key reads up no key counts, so typing right after a release never cancels the clip.
// A key released during the hold counts again when it is pressed again.
export const sampleHold = (
  tracker: HoldTracker,
  sample: { readonly hold: HoldSample; readonly otherKeys: () => bigint },
): readonly [HoldTracker, ReadonlyArray<HoldEvent>] => {
  const [debounce, edge] = debounceHold(tracker.debounce, sample.hold);
  const holdEvents = listEdgeEvents(edge);

  const isSampleHoldUp = sample.hold === "up";
  if (isSampleHoldUp) {
    return [{ debounce, heldAtHoldDown: tracker.heldAtHoldDown }, holdEvents];
  }

  const heldNow = sample.otherKeys();
  const baseline = readBaselineKeys(tracker, heldNow);
  const next = { debounce, heldAtHoldDown: baseline & heldNow };

  const isNotTyping = !debounce.isDown || !isNewlyPressed(baseline, heldNow);
  if (isNotTyping) {
    return [next, holdEvents];
  }

  return [next, [...holdEvents, "otherDown"]];
};

export type TapAction = "stopSpeaking" | "refineClipboard" | "toggleMute";

export const readDoubleTapAction = (request: {
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
