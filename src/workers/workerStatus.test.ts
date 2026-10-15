import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { dictationOwnsAudio, makeStatusWriter } from "./workerStatus.js";

let home = "";

beforeEach(() => {
  home = makeTestFolder("status");
  vi.stubEnv("VOXKEY_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const writer = (request: { readonly recording: boolean }) =>
  makeStatusWriter({ model: "model", backend: "metal", recording: () => request.recording });

describe("dictationOwnsAudio", () => {
  it("holds speech through a hold's release tail, which is already shown as finishing", () => {
    writer({ recording: true }).write("finishing", "Decoding…");
    expect(dictationOwnsAudio()).toBe(true);

    writer({ recording: false }).write("finishing", "4800 samples");
    expect(dictationOwnsAudio()).toBe(false);
  });

  it("holds speech while a newer hold records, even when a queued clip writes its own stage", () => {
    writer({ recording: true }).write("refining", "Refining (codex/default model)…");
    expect(dictationOwnsAudio()).toBe(true);

    writer({ recording: false }).write("inactive", "");
    expect(dictationOwnsAudio()).toBe(false);
  });

  it("holds speech while the dictation worker starts", () => {
    writer({ recording: false }).write("starting", "Loading the dictation model");
    expect(dictationOwnsAudio()).toBe(true);
  });
});
