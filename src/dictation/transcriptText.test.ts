import { describe, expect, it } from "vitest";

import { SAMPLE_RATE } from "./clipAudio.js";
import {
  capWordsForDuration,
  cleanTranscript,
  collapseRepeatedRuns,
  isShortPhrase,
  rejectNoiseHallucination,
  tidyWhisperText,
} from "./transcriptText.js";

describe("transcript text", () => {
  it("caps a hallucinated run on a short clip to the words it could hold", () => {
    const invented = "hello there thank you for watching please subscribe and like this video forever";
    const capped = capWordsForDuration(invented, 8_000);

    expect(capped.split(" ").length).toBeLessThanOrEqual(3);
    expect(capped.startsWith("hello")).toBe(true);
  });

  it("never truncates a real 20 second dictation", () => {
    const spoken =
      "like sometimes when i'm holding the control it still doesn't properly stt everything i'm saying and sometimes it's just partial understand what i'm saying or not even getting it so i'm not sure if it's the mic so please check the logs and fix the silence gate and the token cap";

    expect(spoken.split(" ").length).toBeGreaterThanOrEqual(45);
    expect(capWordsForDuration(spoken, SAMPLE_RATE * 20)).toBe(spoken);
  });

  it("rejects one-word music hallucinations on short clips but keeps real words", () => {
    const halfSecond = SAMPLE_RATE / 2;

    expect(rejectNoiseHallucination("music", halfSecond)).toBe("");
    expect(rejectNoiseHallucination("Music.", halfSecond)).toBe("");
    expect(rejectNoiseHallucination("Thanks for watching!", SAMPLE_RATE * 2)).toBe("");
    expect(rejectNoiseHallucination("hello", halfSecond)).toBe("hello");
  });

  it("collapses repeated words", () => {
    expect(collapseRepeatedRuns("hello hello hello")).toBe("hello");
    expect(collapseRepeatedRuns("Hello Hello world")).toBe("Hello world");
    expect(collapseRepeatedRuns("go go go now")).toBe("go now");
    expect(tidyWhisperText(" go go now ", SAMPLE_RATE * 2)).toBe("go now");
  });

  it("never types no-speech markers or tags", () => {
    for (const marker of ["", "  ", "[MUSIC]", "[BLANK_AUDIO]", "no speech detected", "..."]) {
      expect(cleanTranscript(marker)).toBe("");
    }
    expect(cleanTranscript("hello world")).toBe("hello world");
    expect(cleanTranscript("hello [MUSIC] world")).toBe("hello world");
  });

  it("skips refine for phrases under five words", () => {
    expect(isShortPhrase("Thank you.")).toBe(true);
    expect(isShortPhrase("I'm going to go.")).toBe(true);
    expect(isShortPhrase("Check the worktrees folder and push every branch.")).toBe(false);
  });
});
