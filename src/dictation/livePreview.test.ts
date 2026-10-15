import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStatusWriter } from "../workers/workerStatus.js";
import { captionLoop, makeLiveCaption } from "./livePreview.js";
import { makeClipBuffer } from "./microphone.js";
import type { Transcriber } from "./transcriber.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "caption-"));
  vi.stubEnv("VOXKEY_HOME", home);
  vi.stubEnv("VOXKEY_CONFIG_FILE", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("live caption", () => {
  it("drops a caption pass that finishes after its hold ended and a new hold began", async () => {
    const clip = makeClipBuffer();
    const caption = makeLiveCaption();
    clip.begin();
    for (let frame = 0; frame < 20; frame += 1) {
      clip.append(new Int16Array(512).fill(1_000));
    }
    let passes = 0;
    // While Whisper is busy with the first hold's tail, Shift is released and pressed again.
    const transcriber: Transcriber = {
      modelName: "fake",
      transcribe: () => Effect.die("final decodes are not part of this test"),
      caption: () =>
        Effect.sync(() => {
          passes += 1;
          clip.end();
          clip.begin();
          return Option.some("words from the earlier hold");
        }),
      warm: Effect.void,
      release: Effect.void,
    };
    const status = makeStatusWriter({ model: "fake", backend: "none", recording: clip.isConfirmedHold });

    await Effect.runPromise(
      Effect.ignore(Effect.timeout(captionLoop({ clip, transcriber, caption, status }), "300 millis")),
    );

    expect(passes).toBe(1);
    expect(caption.take()).toBe("");
  });
});
