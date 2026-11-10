import { describe, expect, it, vi } from "vitest";

import { makeClipBuffer, openMicrophone } from "./microphone.js";

// The recorder is the only external system here: one frame arrives, then the device fails.
// The code calls `new PvRecorder(...)`, and vitest cannot construct an arrow-function mock, so the fake is a class.
vi.mock("@picovoice/pvrecorder-node", () => {
  class FakeRecorder {
    readonly start = () => undefined;
    readonly stop = () => undefined;
    readonly release = () => undefined;
    readonly getSelectedDevice = () => "Fake microphone";
    readonly read = vi
      .fn()
      .mockResolvedValueOnce(new Int16Array(512).fill(100))
      .mockRejectedValue(new Error("device gone"));
  }
  return { PvRecorder: FakeRecorder };
});

describe("clip buffer", () => {
  it("marks a clip as a hold only while it records, until it ends or is cancelled", () => {
    const clip = makeClipBuffer();
    clip.confirm();
    expect(clip.isConfirmedHold()).toBe(false);

    clip.begin();
    clip.confirm();
    expect(clip.isConfirmedHold()).toBe(true);
    clip.end();
    expect(clip.isConfirmedHold()).toBe(false);

    clip.begin();
    clip.confirm();
    clip.cancel();
    expect(clip.isConfirmedHold()).toBe(false);
  });

  it("numbers each clip, so work started for an earlier clip can tell it is late", () => {
    const clip = makeClipBuffer();
    clip.begin();
    const first = clip.clipNumber();
    clip.end();
    clip.begin();
    expect(clip.clipNumber()).toBe(first + 1);
  });
});

describe("openMicrophone", () => {
  it("reports a failed read instead of going on with no audio", async () => {
    const clip = makeClipBuffer();
    clip.begin();

    const microphone = await openMicrophone(clip);
    await expect(microphone.failure).rejects.toThrow("Microphone: device gone");
    microphone.close();

    expect(clip.sampleCount()).toBe(512);
  });
});
