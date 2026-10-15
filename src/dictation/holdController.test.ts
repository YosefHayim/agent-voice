import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readConfig } from "../settings/configFile.js";
import { stopSpeech } from "../workers/workerProcesses.js";
import { makeStatusWriter } from "../workers/workerStatus.js";
import { makeHoldController } from "./holdController.js";
import type { Keyboard } from "./keyboard.js";
import { makeLiveCaption } from "./livePreview.js";
import { makeClipBuffer } from "./microphone.js";

// The real one signals the speech worker named in speech.pid; the tests only count the stops.
vi.mock("../workers/workerProcesses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workers/workerProcesses.js")>()),
  stopSpeech: vi.fn(),
}));

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "hold-"));
  vi.stubEnv("VOXKEY_HOME", home);
  vi.stubEnv("VOXKEY_CONFIG_FILE", undefined);
  vi.mocked(stopSpeech).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A keyboard whose Shift is held while `shift.down` is true. */
const shiftKeyboard = (shift: { down: boolean }): Keyboard => ({
  shiftDown: () => shift.down,
  otherKeysDown: () => 0n,
  typeUnicode: () => undefined,
  pressReturn: () => undefined,
  pressCommandV: () => undefined,
  releaseShift: () => undefined,
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
    queue: { offer: () => Effect.succeed(true), isIdle: () => true },
  });
  // Enough samples to pass the debounce: 2 down, 4 up.
  for (const down of [true, false, true, false]) {
    shift.down = down;
    await Effect.runPromise(Effect.repeatN(controller.poll, 4));
  }
};

const savedMute = async () => {
  const config = await Effect.runPromise(readConfig);
  return config.speechMuted;
};

describe("double-tap Shift", () => {
  it("mutes speech and stops speech that is about to start", async () => {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ speechMuted: false }));

    await doubleTapShift();

    expect(await savedMute()).toBe(true);
    // The first tap always stops speech; muting stops it again for a reply claimed between the taps.
    expect(stopSpeech).toHaveBeenCalledTimes(2);
  });

  it("unmutes speech without a second stop", async () => {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ speechMuted: true }));

    await doubleTapShift();

    expect(await savedMute()).toBe(false);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
  });
});
