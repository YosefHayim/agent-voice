import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeClipBuffer, openMicrophone } from "./microphone.js";

// The recorder is the only external system here: one frame arrives, then the device fails.
vi.mock("@picovoice/pvrecorder-node", () => {
  const fakeRecorder = () => {
    const frame = new Int16Array(512).fill(100);
    const deviceGone = new Error("device gone");
    return {
      start: () => undefined,
      stop: () => undefined,
      release: () => undefined,
      getSelectedDevice: () => "Fake microphone",
      read: vi.fn().mockResolvedValueOnce(frame).mockRejectedValue(deviceGone),
    };
  };
  return { PvRecorder: vi.fn(fakeRecorder) };
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

    const readFailure = openMicrophone(clip).pipe(
      Effect.flatMap((microphone) => Effect.flip(microphone.failure)),
      Effect.scoped,
    );
    const failure = await Effect.runPromise(readFailure);

    expect(failure.message).toBe("Microphone: device gone");
    expect(clip.sampleCount()).toBe(512);
  });
});
