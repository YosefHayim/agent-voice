import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStatusWriter } from "../workers/workerStatus.js";
import { startDictationQueue } from "./dictationQueue.js";
import type { Keyboard } from "./keyboard.js";
import type { Transcriber } from "./transcriber.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";
let cmuxLog = "";

// A fake cmux first on PATH records any call, so the test never drives the real cmux app.
beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "queue-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  cmuxLog = path.join(home, "cmux.log");
  writeFileSync(path.join(bin, "cmux"), `#!/bin/sh\necho "$@" >> '${cmuxLog}'\necho '{"surface_id":"s1"}'\n`);
  chmodSync(path.join(bin, "cmux"), 0o755);
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("VOXKEY_HOME", home);
  vi.stubEnv("VOXKEY_CONFIG_FILE", undefined);
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ refineMode: "dictation", refineSendTo: "cmux-new" }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A keyboard that records what would be typed at the caret. */
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
  caption: () => Effect.succeed(Option.none()),
  warm: Effect.void,
  release: Effect.void,
});

describe("dictation queue", () => {
  it("types dictation that was not refined at the caret, even when refined prompts go to cmux", async () => {
    const { keyboard, typed } = fakeKeyboard();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
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
        }),
      ),
    );

    expect(typed).toEqual(["Yes do it "]);
    expect(existsSync(cmuxLog)).toBe(false);
  });
});
