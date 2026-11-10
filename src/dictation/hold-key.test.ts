import { describe, expect, it } from "vitest";

import {
  classifyTap,
  debounceHold,
  type HoldAction,
  type HoldEvent,
  type HoldStatus,
  holdTransition,
  initialHoldDebounce,
  initialHoldTracker,
  isNewlyPressed,
  readDoubleTapAction,
  sampleHold,
} from "./hold-key.js";

const replay = (events: ReadonlyArray<HoldEvent>) =>
  events.reduce<readonly [HoldStatus, HoldAction]>(
    ([status], event) => holdTransition(status, event),
    ["idle", "none"],
  );

type HoldCase = {
  readonly name: string;
  readonly events: ReadonlyArray<HoldEvent>;
  readonly state: HoldStatus;
  readonly action: HoldAction;
};

const holdCases: ReadonlyArray<HoldCase> = [
  { name: "Shift down schedules the hold", events: ["holdDown"], state: "waiting", action: "schedule" },
  { name: "a long hold starts listening", events: ["holdDown", "holdElapsed"], state: "listening", action: "start" },
  { name: "a short press is a tap", events: ["holdDown", "holdUp"], state: "idle", action: "tap" },
  { name: "typing a capital letter cancels", events: ["holdDown", "otherDown"], state: "shortcut", action: "cancel" },
  {
    name: "releasing after a cancel does nothing",
    events: ["holdDown", "otherDown", "holdUp"],
    state: "idle",
    action: "none",
  },
  {
    name: "a key pressed while listening drops the clip",
    events: ["holdDown", "holdElapsed", "otherDown"],
    state: "shortcut",
    action: "cancel",
  },
  {
    name: "releasing while listening stops and keeps the clip",
    events: ["holdDown", "holdElapsed", "holdUp"],
    state: "idle",
    action: "stop",
  },
  { name: "a stray hold timer while idle does nothing", events: ["holdElapsed"], state: "idle", action: "none" },
];

describe("holdTransition", () => {
  it.each(holdCases)("$name", ({ events, state: status, action }) => {
    expect(replay(events)).toEqual([status, action]);
  });
});

describe("newlyPressed", () => {
  const stuckKey = 1n;
  const letter = 1n << 12n;

  it("ignores a key held before Shift went down", () => {
    expect(isNewlyPressed(stuckKey, stuckKey)).toBe(false);
  });

  it("counts a new key pressed while Shift is held", () => {
    expect(isNewlyPressed(stuckKey, stuckKey | letter)).toBe(true);
  });

  it("sees no typing when no key is held", () => {
    expect(isNewlyPressed(0n, 0n)).toBe(false);
  });
});

describe("debounceHold", () => {
  // [sample index, edge] for every edge, so the exact debounce lengths are locked down.
  const run = (samples: ReadonlyArray<"down" | "up">) => {
    let debounce = initialHoldDebounce;
    const edges: Array<readonly [number, string]> = [];
    for (const [index, sample] of samples.entries()) {
      const [next, edge] = debounceHold(debounce, sample);
      debounce = next;

      const isEdgeNotNone = edge !== "none";
      if (isEdgeNotNone) {
        edges.push([index, edge]);
      }
    }
    return edges;
  };

  it("reports Shift down on the second down sample and up on the fourth up sample", () => {
    expect(run(["down", "down", "down", "up", "up", "up", "up"])).toEqual([
      [1, "holdDown"],
      [6, "holdUp"],
    ]);
  });

  it("ignores a one-sample blip in either direction", () => {
    expect(run(["down", "up", "up", "up", "up"])).toEqual([]);
    expect(run(["down", "down", "up", "down", "down", "up", "up", "up", "up"])).toEqual([
      [1, "holdDown"],
      [8, "holdUp"],
    ]);
  });
});

describe("sampleHold", () => {
  const letter = 1n << 0x0en;
  const stuckKey = 1n;

  // [sample index, event] for every event the samples produce.
  const run = (samples: ReadonlyArray<readonly ["down" | "up", bigint]>) => {
    let tracker = initialHoldTracker;
    const events: Array<readonly [number, string]> = [];
    for (const [index, [hold, keys]] of samples.entries()) {
      const [next, produced] = sampleHold(tracker, { hold, otherKeys: () => keys });
      tracker = next;
      const indexed = produced.map((event) => [index, event] as const);
      events.push(...indexed);
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
      [1, "holdDown"],
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
      [1, "holdDown"],
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
      [1, "holdDown"],
      [5, "holdUp"],
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
    expect(readDoubleTapAction({ isSpeaking: true, clipboardRefine: true })).toBe("stopSpeaking");
    expect(readDoubleTapAction({ isSpeaking: false, clipboardRefine: true })).toBe("refineClipboard");
    expect(readDoubleTapAction({ isSpeaking: false, clipboardRefine: false })).toBe("toggleMute");
  });
});
