import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { readConfig } from "../settings/configFile.js";
import { stopSpeech } from "../workers/workerProcesses.js";
import { makeStatusWriter } from "../workers/workerStatus.js";
import { makeHoldController } from "./holdController.js";
import { HOLD_THRESHOLD_MS } from "./holdKey.js";
import type { Keyboard } from "./keyboard.js";
import { makeLiveCaption } from "./livePreview.js";
import { makeClipBuffer } from "./microphone.js";

// The real one signals the speech worker named in speech.pid; the tests only count the stops.
vi.mock("../workers/workerProcesses.js", async (importOriginal) => {
  const workerProcesses = await importOriginal<typeof import("../workers/workerProcesses.js")>();
  return { ...workerProcesses, stopSpeech: vi.fn() };
});

let home = "";

const writeConfig = (config: { readonly speechMuted: boolean }) => {
  const configPath = path.join(home, "config.json");
  const configText = JSON.stringify(config);
  writeFileSync(configPath, configText);
};

beforeEach(() => {
  home = makeTestFolder("hold");
  vi.stubEnv("AGENT_VOICE_HOME", home);
  vi.stubEnv("AGENT_VOICE_CONFIG_FILE", undefined);
  vi.mocked(stopSpeech).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const shiftKeyboard = (shift: { down: boolean }): Keyboard => ({
  holdKey: "shift",
  otherModifiersDown: () => false,
  holdDown: () => shift.down,
  otherKeysDown: () => 0n,
  typeUnicode: () => undefined,
  pressReturn: () => undefined,
  pressCommandV: () => undefined,
  releaseHoldKey: () => undefined,
  accessibilityAllowed: () => true,
  inputMonitoringAllowed: () => true,
  postingAllowed: () => true,
});

const doubleTapShift = async () => {
  const shift = { down: false };
  const controller = makeHoldController({
    keyboard: shiftKeyboard(shift),
    clip: makeClipBuffer(),
    caption: makeLiveCaption(),
    status: makeStatusWriter({ model: "fake", backend: "none", recording: () => false }),
    queue: { offer: () => Effect.void, isIdle: () => true },
  });
  // Enough samples to pass the debounce: 2 down, 4 up.
  for (const down of [true, false, true, false]) {
    shift.down = down;
    const samples = Effect.repeatN(controller.poll, 4);
    await Effect.runPromise(samples);
  }
};

const savedMute = async () => {
  const config = await Effect.runPromise(readConfig);
  return config.speechMuted;
};

describe("double-tap Shift", () => {
  it("mutes speech and stops speech that is about to start", async () => {
    writeConfig({ speechMuted: false });

    await doubleTapShift();

    expect(await savedMute()).toBe(true);
    // The first tap always stops speech; muting stops it again for a reply claimed between the taps.
    expect(stopSpeech).toHaveBeenCalledTimes(2);
  });

  it("unmutes speech without a second stop", async () => {
    writeConfig({ speechMuted: true });

    await doubleTapShift();

    expect(await savedMute()).toBe(false);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
  });
});

const rightOptionController = () => {
  const pressed = { down: false, modifiers: false, keys: 0n };
  const clip = makeClipBuffer();
  const offer = vi.fn(() => Effect.void);
  const keyboard: Keyboard = {
    ...shiftKeyboard(pressed),
    holdKey: "right-option",
    otherModifiersDown: () => pressed.modifiers,
    otherKeysDown: () => pressed.keys,
  };
  const controller = makeHoldController({
    keyboard,
    clip,
    caption: makeLiveCaption(),
    status: makeStatusWriter({ model: "fake", backend: "none", recording: clip.isConfirmedHold }),
    queue: { offer, isIdle: () => true },
  });
  const poll = Effect.repeatN(controller.poll, 4);
  return { pressed, clip, offer, poll };
};

describe("Right Option hold-only dictation", () => {
  it("ignores taps and double taps without changing speech mute", async () => {
    writeConfig({ speechMuted: true });
    const hold = rightOptionController();
    for (const down of [true, false, true, false]) {
      hold.pressed.down = down;
      await Effect.runPromise(hold.poll);
    }

    expect(hold.clip.isRecording()).toBe(false);
    expect(hold.offer).not.toHaveBeenCalled();
    expect(stopSpeech).not.toHaveBeenCalled();
    expect(await savedMute()).toBe(true);
  });

  it("records only after the threshold and queues one clip after release", async () => {
    const hold = rightOptionController();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const recording = Effect.gen(function* () {
        hold.pressed.down = true;
        yield* hold.poll;
        expect(hold.clip.isConfirmedHold()).toBe(false);
        hold.clip.append(new Int16Array([1000, 2000]));
        clock.mockReturnValue(now + HOLD_THRESHOLD_MS + 1);
        yield* hold.poll;
        expect(hold.clip.isConfirmedHold()).toBe(true);
        expect(hold.offer).not.toHaveBeenCalled();
        hold.pressed.down = false;
        hold.pressed.modifiers = true;
        yield* hold.poll;
      }).pipe(Effect.awaitAllChildren);
      await Effect.runPromise(recording);

      expect(hold.offer).toHaveBeenCalledOnce();
      expect(hold.clip.isRecording()).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["before", "during"])("cancels modifiers held %s Right Option", async (when) => {
    const hold = rightOptionController();
    hold.pressed.modifiers = when === "before";
    hold.pressed.down = true;
    await Effect.runPromise(hold.poll);
    hold.pressed.modifiers = true;
    await Effect.runPromise(hold.poll);
    expect(hold.clip.isRecording()).toBe(false);
    hold.pressed.down = false;
    await Effect.runPromise(hold.poll);
    expect(hold.offer).not.toHaveBeenCalled();
    expect(stopSpeech).not.toHaveBeenCalled();
  });

  it("cancels when another key is typed while Right Option is held", async () => {
    const hold = rightOptionController();
    hold.pressed.down = true;
    await Effect.runPromise(hold.poll);
    hold.pressed.keys = 1n << 0x01n;
    await Effect.runPromise(hold.poll);
    expect(hold.clip.isRecording()).toBe(false);
    expect(hold.offer).not.toHaveBeenCalled();
  });
});
