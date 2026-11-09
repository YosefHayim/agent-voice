import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "#src/testing/test-folder.js";
import { makeStatusWriter } from "#src/workers/worker-status.js";
import { captionLoop, makeLiveCaption } from "./live-preview.js";
import { makeClipBuffer } from "./microphone.js";
import type { Transcriber } from "./transcriber.js";

let home = "";

beforeEach(() => {
  home = makeTestFolder("caption");
  vi.stubEnv("AGENT_VOICE_HOME", home);
  vi.stubEnv("AGENT_VOICE_CONFIG_FILE", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const captionWindowMilliseconds = 300;

describe("live caption", () => {
  it("drops a caption pass that finishes after its hold ended and a new hold began", async () => {
    const clip = makeClipBuffer();
    const caption = makeLiveCaption();
    const frames = Array.from({ length: 20 }, () => new Int16Array(512).fill(1_000));
    clip.begin();
    for (const frame of frames) {
      clip.append(frame);
    }
    let passes = 0;
    // While Whisper is busy with the first hold's tail, Shift is released and pressed again.
    const transcriber: Transcriber = {
      modelName: "fake",
      transcribe: async () => {
        throw new Error("final decodes are not part of this test");
      },
      caption: async () => {
        passes += 1;
        clip.end();
        clip.begin();
        return "words from the earlier hold";
      },
      warmUp: async () => undefined,
      release: async () => undefined,
    };
    const status = makeStatusWriter({ model: "fake", backend: "none", recording: clip.isConfirmedHold });
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), captionWindowMilliseconds);

    await captionLoop({ clip, transcriber, caption, status, shutdown: shutdown.signal });

    expect(passes).toBe(1);
    expect(caption.take()).toBe("");
  });
});
