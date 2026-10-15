import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { makeStatusWriter } from "../workers/workerStatus.js";
import { startDictationQueue } from "./dictationQueue.js";
import type { Keyboard } from "./keyboard.js";
import type { Transcriber } from "./transcriber.js";

let home = "";
let cmuxLog = "";

// A fake cmux first on PATH records any call, so the test never drives the real cmux app.
beforeEach(() => {
  home = makeTestFolder("queue");
  const bin = path.join(home, "bin");
  const cmuxPath = path.join(bin, "cmux");
  const configPath = path.join(home, "config.json");
  const config = JSON.stringify({ refineMode: "dictation", refineSendTo: "cmux-new" });
  cmuxLog = path.join(home, "cmux.log");
  mkdirSync(bin);
  writeFileSync(cmuxPath, `#!/bin/sh\necho "$@" >> '${cmuxLog}'\necho '{"surface_id":"s1"}'\n`);
  chmodSync(cmuxPath, 0o755);
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("VOXKEY_HOME", home);
  vi.stubEnv("VOXKEY_CONFIG_FILE", undefined);
  writeFileSync(configPath, config);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// Records what would be typed at the caret.
const fakeKeyboard = (): { readonly keyboard: Keyboard; readonly typed: ReadonlyArray<string> } => {
  const typed: Array<string> = [];
  const keyboard: Keyboard = {
    shiftDown: () => false,
    otherKeysDown: () => 0n,
    typeUnicode: (text) => {
      typed.push(text);
    },
    pressReturn: () => undefined,
    pressCommandV: () => undefined,
    releaseShift: () => undefined,
    accessibilityAllowed: () => true,
    inputMonitoringAllowed: () => true,
    postingAllowed: () => true,
  };
  return { keyboard, typed };
};

const fakeTranscriber = (heard: string): Transcriber => ({
  modelName: "fake",
  transcribe: () => Effect.succeed({ text: heard, decodeMs: 1, inputLevel: 0.2, ranWhisper: true }),
  caption: () => Effect.succeedNone,
  warm: Effect.void,
  release: Effect.void,
});

describe("dictation queue", () => {
  it("types dictation that was not refined at the caret, even when refined prompts go to cmux", async () => {
    const { keyboard, typed } = fakeKeyboard();
    const dictation = Effect.gen(function* () {
      const queue = yield* startDictationQueue({
        transcriber: fakeTranscriber("yes do it"),
        keyboard,
        status: makeStatusWriter({ model: "fake", backend: "none", recording: () => false }),
      });
      yield* queue.offer({ samples: new Float32Array(16_000), fallbackCaption: "", generation: 1 });
      const deadline = Date.now() + 3_000;
      while (typed.length === 0 && Date.now() < deadline) {
        yield* Effect.sleep("20 millis");
      }
    }).pipe(Effect.scoped);
    await Effect.runPromise(dictation);

    expect(typed).toEqual(["Yes do it "]);
    expect(existsSync(cmuxLog)).toBe(false);
  });
});
