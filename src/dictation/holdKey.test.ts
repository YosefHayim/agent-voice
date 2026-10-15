import { describe, expect, it } from "vitest";

import {
  classifyTap,
  debounceShift,
  doubleTapAction,
  type HoldAction,
  type HoldEvent,
  type HoldState,
  holdTransition,
  initialShiftDebounce,
  initialShiftTracker,
  newlyPressed,
  sampleShift,
} from "./holdKey.js";

const replay = (events: ReadonlyArray<HoldEvent>) =>
  events.reduce<readonly [HoldState, HoldAction]>(([state], event) => holdTransition(state, event), ["idle", "none"]);

type HoldCase = {
  readonly name: string;
  readonly events: ReadonlyArray<HoldEvent>;
  readonly state: HoldState;
  readonly action: HoldAction;
};

const holdCases: ReadonlyArray<HoldCase> = [
  { name: "Shift down schedules the hold", events: ["shiftDown"], state: "waiting", action: "schedule" },
  { name: "a long hold starts listening", events: ["shiftDown", "holdElapsed"], state: "listening", action: "start" },
  { name: "a short press is a tap", events: ["shiftDown", "shiftUp"], state: "idle", action: "tap" },
  { name: "typing a capital letter cancels", events: ["shiftDown", "otherDown"], state: "shortcut", action: "cancel" },
  {
    name: "releasing after a cancel does nothing",
    events: ["shiftDown", "otherDown", "shiftUp"],
    state: "idle",
    action: "none",
  },
  {
    name: "a key pressed while listening drops the clip",
    events: ["shiftDown", "holdElapsed", "otherDown"],
    state: "shortcut",
    action: "cancel",
  },
  {
    name: "releasing while listening stops and keeps the clip",
    events: ["shiftDown", "holdElapsed", "shiftUp"],
    state: "idle",
    action: "stop",
  },
  { name: "a stray hold timer while idle does nothing", events: ["holdElapsed"], state: "idle", action: "none" },
];

describe("holdTransition", () => {
  it.each(holdCases)("$name", ({ events, state, action }) => {
    expect(replay(events)).toEqual([state, action]);
  });
});

describe("newlyPressed", () => {
  const stuckKey = 1n;
  const letter = 1n << 12n;

  it("ignores a key held before Shift went down", () => {
    expect(newlyPressed(stuckKey, stuckKey)).toBe(false);
  });

  it("counts a new key pressed while Shift is held", () => {
    expect(newlyPressed(stuckKey, stuckKey | letter)).toBe(true);
  });

  it("sees no typing when no key is held", () => {
    expect(newlyPressed(0n, 0n)).toBe(false);
  });
});

describe("debounceShift", () => {
  // [sample index, edge] for every edge, so the exact debounce lengths are locked down.
  const run = (samples: ReadonlyArray<boolean>) => {
    let debounce = initialShiftDebounce;
    const edges: Array<readonly [number, string]> = [];
    for (const [index, sample] of samples.entries()) {
      const [next, edge] = debounceShift(debounce, sample ? "down" : "up");
      debounce = next;
      if (edge !== "none") {
        edges.push([index, edge]);
      }
    }
    return edges;
  };

  it("reports Shift down on the second down sample and up on the fourth up sample", () => {
    expect(run([true, true, true, false, false, false, false])).toEqual([
      [1, "shiftDown"],
      [6, "shiftUp"],
    ]);
  });

  it("ignores a one-sample blip in either direction", () => {
    expect(run([true, false, false, false, false])).toEqual([]);
    expect(run([true, true, false, true, true, false, false, false, false])).toEqual([
      [1, "shiftDown"],
      [8, "shiftUp"],
    ]);
  });
});

describe("sampleShift", () => {
  const letter = 1n << 0x0en;
  const stuckKey = 1n;

  // [sample index, event] for every event the samples produce.
  const run = (samples: ReadonlyArray<readonly ["down" | "up", bigint]>) => {
    let tracker = initialShiftTracker;
    const events: Array<readonly [number, string]> = [];
    for (const [index, [shift, keys]] of samples.entries()) {
      const [next, produced] = sampleShift(tracker, { shift, otherKeys: () => keys });
      tracker = next;
      events.push(...produced.map((event) => [index, event] as const));
    }
    return events;
  };

  it("counts a key pressed while Shift is still debouncing down, so a fast capital letter is never a hold", () => {
    expect(
      run([
        ["down", 0n],
        ["down", letter],
      ]),
    ).toEqual([
      [1, "shiftDown"],
      [1, "otherDown"],
    ]);
  });

  it("ignores a key already held when Shift first reads down, and counts one pressed during the hold", () => {
    expect(
      run([
        ["down", stuckKey],
        ["down", stuckKey],
        ["down", stuckKey],
        ["down", stuckKey | letter],
      ]),
    ).toEqual([
      [1, "shiftDown"],
      [3, "otherDown"],
    ]);
  });

  it("never counts typing that starts right after Shift is released, while the up edge debounces", () => {
    expect(
      run([
        ["down", 0n],
        ["down", 0n],
        ["up", 0n],
        ["up", letter],
        ["up", letter],
        ["up", letter],
      ]),
    ).toEqual([
      [1, "shiftDown"],
      [5, "shiftUp"],
    ]);
  });
});

describe("taps", () => {
  it("treats a second tap within 400 ms as a double tap", () => {
    expect(classifyTap({ lastTapAt: 1_000, now: 1_300 })).toEqual({ double: true, rememberedTapAt: undefined });
    expect(classifyTap({ lastTapAt: 1_000, now: 1_500 })).toEqual({ double: false, rememberedTapAt: 1_500 });
    expect(classifyTap({ lastTapAt: undefined, now: 10 })).toEqual({ double: false, rememberedTapAt: 10 });
  });

  it("stops speech first, then refines the clipboard, else toggles the mute", () => {
    expect(doubleTapAction({ isSpeaking: true, clipboardRefine: true })).toBe("stopSpeaking");
    expect(doubleTapAction({ isSpeaking: false, clipboardRefine: true })).toBe("refineClipboard");
    expect(doubleTapAction({ isSpeaking: false, clipboardRefine: false })).toBe("toggleMute");
  });
});
