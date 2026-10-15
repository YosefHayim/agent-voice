import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictationOwnsAudio, makeStatusWriter } from "./workerStatus.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "status-"));
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
