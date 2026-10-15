import { describe, expect, it } from "vitest";

import { characterIds, chunkSpeech, speedForWordsPerMinute, supertonicText } from "./speechChunks.js";
import { decodeWav, encodeWav } from "./wavFile.js";

describe("chunkSpeech", () => {
  it("splits at the last sentence end that fits", () => {
    expect(chunkSpeech("One two. Three four. Five six.", 21)).toEqual(["One two. Three four.", "Five six."]);
  });

  it("falls back to the last space, then to a hard cut", () => {
    expect(chunkSpeech("alpha beta gamma", 12)).toEqual(["alpha beta", "gamma"]);
    expect(chunkSpeech("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps short text whole and drops blank chunks", () => {
    expect(chunkSpeech("Hello.", 280)).toEqual(["Hello."]);
    expect(chunkSpeech("   ", 280)).toEqual([]);
  });
});

describe("supertonicText", () => {
  it("normalizes symbols, spacing, and quotes, ends with a period, and adds the language tags", () => {
    expect(supertonicText("Use foo_bar — see “docs” @ home , ok")).toBe(
      '<en>Use foo bar - see "docs" at home, ok.</en>',
    );
  });

  it("keeps existing end punctuation and removes emoji", () => {
    expect(supertonicText("Done! 🎉")).toBe("<en>Done!</en>");
  });
});

describe("characterIds", () => {
  it("maps characters through the indexer and drops unsupported ones", () => {
    const indexer = Array.from({ length: 128 }, (_unused, code) => (code === 0x7e ? -1 : code + 1000));
    expect(characterIds("a~b", indexer)).toEqual([1097, 1098]);
  });
});

describe("speedForWordsPerMinute", () => {
  it("turns 230 wpm into 1.15x and clamps to 0.7–2.0", () => {
    expect(speedForWordsPerMinute(230)).toBeCloseTo(1.15);
    expect(speedForWordsPerMinute(80)).toBe(0.7);
    expect(speedForWordsPerMinute(720)).toBe(2);
  });
});

describe("WAV files", () => {
  it("writes 16-bit mono PCM and reads the same samples back", () => {
    const wav = encodeWav({ samples: Float32Array.from([0, 0.5, -0.5, 1]), sampleRate: 44_100 });
    expect(decodeWav(wav)).toEqual({ sampleRate: 44_100, pcm: Int16Array.from([0, 16_384, -16_383, 32_767]) });
    expect(decodeWav(Buffer.from("not a wav file at all"))).toBeUndefined();
  });
});
