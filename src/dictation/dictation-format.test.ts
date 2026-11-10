import { describe, expect, it } from "vitest";

import { createDictationString, parseReplacements, readPromptBoost } from "./dictation-format.js";

describe("formatDictation", () => {
  const replacements = new Map([["Joseph", "Yosef"]]);

  it.each([
    ["Hello comma my name is Joseph period", "Hello, my name is Yosef. "],
    [
      "I need three changes period new line bullet fix authentication next bullet add tests next bullet update documentation",
      "I need three changes.\n- Fix authentication\n- Add tests\n- Update documentation ",
    ],
    ["numbered list fix login next item add tests next item deploy", "1. Fix login\n2. Add tests\n3. Deploy "],
    ["use literal comma as the field name", "Use comma as the field name "],
    ["first new paragraph second", "First\n\nSecond "],
    ["is it ready question mark yes exclamation point", "Is it ready? Yes! "],
    ["", ""],
  ])("formats %j", (spoken, typed) => {
    expect(createDictationString(spoken, replacements)).toBe(typed);
  });

  it("matches multi-word replacements, longest first, ignoring case and trailing punctuation", () => {
    const terms = new Map([
      ["type script", "TypeScript"],
      ["type", "kind"],
    ]);
    expect(createDictationString("I like Type Script.", terms)).toBe("I like TypeScript. ");
    expect(createDictationString("what type is it", terms)).toBe("What kind is it ");
  });

  it("keeps the punctuation Whisper put after a replaced word, so the next sentence still starts with a capital", () => {
    const names = new Map([["Joseph", "Yosef"]]);
    expect(createDictationString("my name is Joseph. thanks", names)).toBe("My name is Yosef. Thanks ");
    expect(createDictationString("Joseph, hi", names)).toBe("Yosef, hi ");
  });

  it("leaves Hebrew words untouched", () => {
    expect(createDictationString("שלום comma עולם", new Map())).toBe("שלום, עולם ");
  });
});

describe("parseReplacements", () => {
  it("keeps only complete heard=written pairs", () => {
    const map = parseReplacements(" Joseph = Yosef ; type script = TypeScript ; broken ; =bad ; empty= ");
    expect([...map]).toEqual([
      ["Joseph", "Yosef"],
      ["type script", "TypeScript"],
    ]);
  });
});

describe("promptBoost", () => {
  it("lists every replacement term once, sorted", () => {
    const boost = readPromptBoost(
      new Map([
        ["type script", "TypeScript"],
        ["joseph", "Yosef"],
      ]),
    );
    expect(boost).toBe("TypeScript, Yosef, joseph, type script");
    expect(readPromptBoost(new Map())).toBe("");
  });
});
