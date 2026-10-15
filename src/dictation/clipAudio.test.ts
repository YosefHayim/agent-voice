import { describe, expect, it } from "vitest";

import {
  extractSpeechRegion,
  MIN_VOICED_SAMPLES,
  NORMALIZE_PEAK,
  pcmFromSamples,
  peakNormalize,
  peakOf,
  prepareForWhisper,
  rootMeanSquare,
  SAMPLE_RATE,
  samplesFromPcm,
  syntheticSpeech,
} from "./clipAudio.js";

describe("clip audio", () => {
  it("tells silence from sound", () => {
    const tone = new Float32Array(1_600).fill(0.2);

    expect(rootMeanSquare(new Float32Array(1_600))).toBeLessThan(0.003);
    expect(rootMeanSquare(tone)).toBeGreaterThan(0.003);
    expect(prepareForWhisper(new Float32Array(SAMPLE_RATE))).toBeUndefined();
  });

  it("lifts a quiet laptop mic into Whisper's range", () => {
    const quiet = Float32Array.from({ length: 8_000 }, (_unused, index) => 0.004 * Math.sin(index * 0.1));
    const lifted = peakNormalize(quiet, NORMALIZE_PEAK);

    expect(rootMeanSquare(quiet)).toBeLessThan(0.01);
    expect(peakOf(lifted)).toBeGreaterThan(0.15);
  });

  it("keeps quiet continuous speech after normalizing", () => {
    const soft = Float32Array.from({ length: SAMPLE_RATE * 3 }, (_unused, index) => 0.006 * Math.sin(index * 0.08));
    const lifted = peakNormalize(soft, NORMALIZE_PEAK);

    expect(extractSpeechRegion(lifted)?.length).toBeGreaterThanOrEqual(MIN_VOICED_SAMPLES);
  });

  it("cuts a loud burst out of steady background noise", () => {
    const noisy = new Float32Array(SAMPLE_RATE).fill(0.005);
    noisy.fill(0.15, 8_000, 12_000);
    const region = extractSpeechRegion(noisy);

    expect(region?.length).toBeLessThan(noisy.length);
    expect(rootMeanSquare(region || new Float32Array())).toBeGreaterThan(0.05);
  });

  it("round-trips PCM and makes synthetic speech the voice detector keeps", () => {
    const pcm = Int16Array.from([0, 16_384, -16_384, 32_767]);
    const samples = samplesFromPcm(pcm);
    const roundTrip = pcmFromSamples(samples);
    const speech = syntheticSpeech(1);

    expect(Array.from(roundTrip)).toEqual([0, 16_384, -16_383, 32_766]);
    expect(prepareForWhisper(speech)).toBeDefined();
  });
});
