import { Effect, Either, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { configSchema, configSettings, defaultConfig, settingValueFromText, withSettingValue } from "./configSchema.js";

const decode = Schema.decodeUnknownEither(configSchema, { onExcessProperty: "error" });

describe("configSchema", () => {
  it("decodes an empty file to the documented defaults", () => {
    expect(defaultConfig).toEqual({
      speechMode: "auto",
      speechMuted: true,
      speechVoice: "F4",
      speechWordsPerMinute: 230,
      dictationLanguage: "en",
      dictationKeepListeningSeconds: 0.2,
      dictationReplacements: "",
      refineMode: "off",
      refineProvider: "codex",
      refinePressEnter: false,
      refineSendTo: "caret",
      refineCmuxCommand: "",
      refineCmuxPressEnter: false,
    });
  });

  it.each([
    ["Hebrew", "he"],
    [" ivrit ", "he"],
    ["iw", "he"],
    ["lang=he", "he"],
    ["English", "en"],
    ["EN-US", "en"],
  ])("accepts the dictation language alias %j as %s", (spoken, language) => {
    expect(Either.getOrThrow(decode({ dictationLanguage: spoken })).dictationLanguage).toBe(language);
  });

  it.each([
    ["agent", "grok"],
    ["agy", "gemini"],
    ["pie", "pi"],
    ["Codex", "codex"],
  ])("accepts the refine provider alias %j as %s", (name, provider) => {
    expect(Either.getOrThrow(decode({ refineProvider: name })).refineProvider).toBe(provider);
  });

  it("accepts a voice in any case and rejects an unknown voice", () => {
    expect(Either.getOrThrow(decode({ speechVoice: "m3" })).speechVoice).toBe("M3");
    expect(Either.isLeft(decode({ speechVoice: "Z9" }))).toBe(true);
  });

  it("rejects out-of-range numbers, unknown modes, the dropped local provider, and unknown keys", () => {
    expect(Either.isLeft(decode({ dictationKeepListeningSeconds: 9 }))).toBe(true);
    expect(Either.isLeft(decode({ speechWordsPerMinute: 10 }))).toBe(true);
    expect(Either.isLeft(decode({ speechMode: "loud" }))).toBe(true);
    expect(Either.isLeft(decode({ refineProvider: "local" }))).toBe(true);
    expect(Either.isLeft(decode({ unknownSetting: "off" }))).toBe(true);
  });

  it("lists every setting with a kebab-case name, a label, a description, and its choices", () => {
    const names = configSettings.map((setting) => setting.name);
    expect(names).toContain("speech-words-per-minute");
    expect(names).toContain("dictation-keep-listening-seconds");
    expect(configSettings.every((setting) => setting.label !== "" && setting.description !== "")).toBe(true);
    expect(configSettings.find((setting) => setting.key === "dictationLanguage")?.choices).toEqual(["en", "he"]);
    expect(configSettings.find((setting) => setting.key === "refineEffort")?.optional).toBe(true);
    expect(configSettings.find((setting) => setting.key === "speechVoice")?.choices).toHaveLength(10);
  });

  it("turns CLI text into a setting value and clears an optional setting with empty text", () => {
    const keepListening = configSettings.find((setting) => setting.key === "dictationKeepListeningSeconds");
    const refineModel = configSettings.find((setting) => setting.key === "refineModel");
    if (keepListening === undefined || refineModel === undefined) throw new Error("missing settings");

    expect(Effect.runSync(settingValueFromText({ setting: keepListening, text: "1" }))).toEqual(Option.some(1));
    expect(Effect.runSync(settingValueFromText({ setting: refineModel, text: " " }))).toEqual(Option.none());

    const withModel = Effect.runSync(
      withSettingValue({ config: defaultConfig, key: "refineModel", value: Option.some("grok-4.5") }),
    );
    expect(withModel.refineModel).toBe("grok-4.5");
    const cleared = Effect.runSync(withSettingValue({ config: withModel, key: "refineModel", value: Option.none() }));
    expect("refineModel" in cleared).toBe(false);
  });
});
