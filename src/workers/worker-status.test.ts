import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "#src/testing/test-folder.js";
import { isAudioOwnedByDictation, makeStatusWriter } from "./worker-status.js";

let home = "";

beforeEach(() => {
  home = makeTestFolder("status");
  vi.stubEnv("AGENT_VOICE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const createRecordingStatusWriter = (request: { readonly recording: boolean }) =>
  makeStatusWriter({ model: "model", backend: "metal", recording: () => request.recording });

describe("dictationOwnsAudio", () => {
  it("holds speech through a hold's release tail, which is already shown as finishing", () => {
    createRecordingStatusWriter({ recording: true }).write("finishing", "Decoding…");
    expect(isAudioOwnedByDictation()).toBe(true);

    createRecordingStatusWriter({ recording: false }).write("finishing", "4800 samples");
    expect(isAudioOwnedByDictation()).toBe(false);
  });

  it("holds speech while a newer hold records, even when a queued clip writes its own stage", () => {
    createRecordingStatusWriter({ recording: true }).write("refining", "Refining (codex/default model)…");
    expect(isAudioOwnedByDictation()).toBe(true);

    createRecordingStatusWriter({ recording: false }).write("inactive", "");
    expect(isAudioOwnedByDictation()).toBe(false);
  });

  it("holds speech while the dictation worker starts", () => {
    createRecordingStatusWriter({ recording: false }).write("starting", "Loading the dictation model");
    expect(isAudioOwnedByDictation()).toBe(true);
  });
});
