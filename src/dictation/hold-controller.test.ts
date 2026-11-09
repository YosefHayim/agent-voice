import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "#src/settings/config-file.js";
import { makeTestFolder } from "#src/testing/test-folder.js";
import { stopSpeech } from "#src/workers/worker-processes.js";
import { makeStatusWriter } from "#src/workers/worker-status.js";
import { makeHoldController } from "./hold-controller.js";
import { HOLD_THRESHOLD_MS } from "./hold-key.js";
import type { Keyboard } from "./keyboard.js";
import { makeLiveCaption } from "./live-preview.js";
import { makeClipBuffer } from "./microphone.js";

// The real one signals the speech worker named in speech.pid; the tests only count the stops.
vi.mock("#src/workers/worker-processes.js", async (importOriginal) => {
  const workerProcesses = await importOriginal<typeof import("#src/workers/worker-processes.js")>();
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

const makeShutdownSignal = (): AbortSignal => new AbortController().signal;

// Each tap is 4 polls, which is enough samples to pass the debounce.
const pollsPerTap = 4;

const pollTap = (poll: () => void): void => {
  for (let pollCount = 0; pollCount < pollsPerTap; pollCount += 1) {
    poll();
  }
};

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

const doubleTapShift = () => {
  const shift = { down: false };
  const controller = makeHoldController({
    keyboard: shiftKeyboard(shift),
    clip: makeClipBuffer(),
    caption: makeLiveCaption(),
    status: makeStatusWriter({ model: "fake", backend: "none", recording: () => false }),
    queue: { offer: () => undefined, isIdle: () => true },
    shutdown: makeShutdownSignal(),
  });
  for (const down of [true, false, true, false]) {
    shift.down = down;
    pollTap(controller.poll);
  }
};

const savedMute = (): boolean => {
  const savedSettings = readConfig();
  return savedSettings.speechMuted;
};

describe("double-tap Shift", () => {
  it("mutes speech and stops speech that is about to start", () => {
    writeConfig({ speechMuted: false });

    doubleTapShift();

    expect(savedMute()).toBe(true);
    // The first tap always stops speech; muting stops it again for a reply claimed between the taps.
    expect(stopSpeech).toHaveBeenCalledTimes(2);
  });

  it("unmutes speech without a second stop", () => {
    writeConfig({ speechMuted: true });

    doubleTapShift();

    expect(savedMute()).toBe(false);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
  });
});

const rightOptionController = () => {
  const pressed = { down: false, modifiers: false, keys: 0n };
  const clip = makeClipBuffer();
  const offer = vi.fn(() => undefined);
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
    shutdown: makeShutdownSignal(),
  });
  return { pressed, clip, offer, poll: controller.poll };
};

describe("Right Option hold-only dictation", () => {
  it("ignores taps and double taps without changing speech mute", () => {
    writeConfig({ speechMuted: true });
    const hold = rightOptionController();
    for (const down of [true, false, true, false]) {
      hold.pressed.down = down;
      pollTap(hold.poll);
    }

    expect(hold.clip.isRecording()).toBe(false);
    expect(hold.offer).not.toHaveBeenCalled();
    expect(stopSpeech).not.toHaveBeenCalled();
    expect(savedMute()).toBe(true);
  });

  it("records only after the threshold and queues one clip after release", () => {
    const hold = rightOptionController();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      hold.pressed.down = true;
      pollTap(hold.poll);
      expect(hold.clip.isConfirmedHold()).toBe(false);
      hold.clip.append(new Int16Array([1000, 2000]));
      clock.mockReturnValue(now + HOLD_THRESHOLD_MS + 1);
      pollTap(hold.poll);
      expect(hold.clip.isConfirmedHold()).toBe(true);
      expect(hold.offer).not.toHaveBeenCalled();
      hold.pressed.down = false;
      hold.pressed.modifiers = true;
      pollTap(hold.poll);

      expect(hold.offer).toHaveBeenCalledOnce();
      expect(hold.clip.isRecording()).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["before", "during"])("cancels modifiers held %s Right Option", (when) => {
    const hold = rightOptionController();
    hold.pressed.modifiers = when === "before";
    hold.pressed.down = true;
    pollTap(hold.poll);
    hold.pressed.modifiers = true;
    pollTap(hold.poll);
    expect(hold.clip.isRecording()).toBe(false);
    hold.pressed.down = false;
    pollTap(hold.poll);

    expect(hold.offer).not.toHaveBeenCalled();
    expect(stopSpeech).not.toHaveBeenCalled();
  });

  it("cancels when another key is typed while Right Option is held", () => {
    const hold = rightOptionController();
    hold.pressed.down = true;
    pollTap(hold.poll);
    hold.pressed.keys = 1n << 0x01n;
    pollTap(hold.poll);

    expect(hold.clip.isRecording()).toBe(false);
    expect(hold.offer).not.toHaveBeenCalled();
  });
});
