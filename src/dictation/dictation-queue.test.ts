import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sleep } from "#src/sleep.js";
import { makeTestFolder } from "#src/testing/test-folder.js";
import { makeStatusWriter } from "#src/workers/worker-status.js";
import { startDictationQueue } from "./dictation-queue.js";
import type { Keyboard } from "./keyboard.js";
import type { Transcriber } from "./transcriber.js";

let home = "";
let cmuxLog = "";

// A fake cmux first on PATH records any call, so the test never drives the real cmux app.
beforeEach(() => {
  home = makeTestFolder("queue");
  const bin = path.join(home, "bin");
  const cmuxPath = path.join(bin, "cmux");
  const settingsPath = path.join(home, "config.json");
  const settingsFileMessages = JSON.stringify({ refineMode: "dictation", refineSendTo: "cmux-new" });
  cmuxLog = path.join(home, "cmux.log");
  mkdirSync(bin);
  writeFileSync(cmuxPath, `#!/bin/sh\necho "$@" >> '${cmuxLog}'\necho '{"surface_id":"s1"}'\n`);
  chmodSync(cmuxPath, 0o755);
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("AGENT_VOICE_HOME", home);
  vi.stubEnv("AGENT_VOICE_CONFIG_FILE", undefined);
  writeFileSync(settingsPath, settingsFileMessages);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// Records what would be typed at the caret.
const createFakeKeyboard = (): { readonly keyboard: Keyboard; readonly typed: ReadonlyArray<string> } => {
  const typed: Array<string> = [];
  const keyboard: Keyboard = {
    holdKey: "shift",
    otherModifiersDown: () => false,
    holdDown: () => false,
    otherKeysDown: () => 0n,
    typeUnicode: (string) => {
      typed.push(string);
    },
    pressReturn: () => undefined,
    pressCommandV: () => undefined,
    releaseHoldKey: () => undefined,
    accessibilityAllowed: () => true,
    inputMonitoringAllowed: () => true,
    postingAllowed: () => true,
  };
  return { keyboard, typed };
};

const createFakeTranscriber = (heard: string): Transcriber => ({
  modelName: "fake",
  transcribe: async () => ({ text: heard, decodeMs: 1, inputLevel: 0.2, ranWhisper: true }),
  readCaption: async () => null,
  warmUp: async () => undefined,
  release: async () => undefined,
});

const typingWaitMilliseconds = 3_000;
const typingPollMilliseconds = 20;

describe("dictation queue", () => {
  it("types dictation that was not refined at the caret, even when refined prompts go to cmux", async () => {
    const { keyboard, typed } = createFakeKeyboard();
    const shutdown = new AbortController();
    const queue = startDictationQueue({
      transcriber: createFakeTranscriber("yes do it"),
      keyboard,
      status: makeStatusWriter({ model: "fake", backend: "none", recording: () => false }),
      shutdown: shutdown.signal,
    });

    queue.offer({ samples: new Float32Array(16_000), fallbackCaption: "", generation: 1 });
    const deadline = Date.now() + typingWaitMilliseconds;
    while (typed.length === 0 && Date.now() < deadline) {
      await sleep(typingPollMilliseconds);
    }
    shutdown.abort();

    expect(typed).toEqual(["Yes do it "]);
    expect(existsSync(cmuxLog)).toBe(false);
  });
});
