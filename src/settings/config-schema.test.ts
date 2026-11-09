import { describe, expect, it } from "vitest";

import { configSettings, decodeConfig, defaultConfig, parseSettingValue, withSettingValue } from "./config-schema.js";

describe("configSchema", () => {
  it("decodes an empty file to the documented defaults", () => {
    expect(defaultConfig).toEqual({
      speechMode: "auto",
      speechMuted: true,
      speechVoice: "F4",
      speechWordsPerMinute: 230,
      dictationHoldKey: "shift",
      dictationLanguage: "en",
      dictationModel: "auto",
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

  it("accepts Right Option and rejects unsupported hold keys", () => {
    expect(decodeConfig({ dictationHoldKey: "right-option" }).dictationHoldKey).toBe("right-option");
    expect(() => decodeConfig({ dictationHoldKey: "left-option" })).toThrow();
    expect(() => decodeConfig({ dictationHoldKey: "command-s" })).toThrow();
  });

  it.each([
    ["Hebrew", "he"],
    [" ivrit ", "he"],
    ["iw", "he"],
    ["lang=he", "he"],
    ["English", "en"],
    ["EN-US", "en"],
  ])("accepts the dictation language alias %j as %s", (spoken, language) => {
    expect(decodeConfig({ dictationLanguage: spoken }).dictationLanguage).toBe(language);
  });

  it.each([
    ["Auto", "auto"],
    ["fast", "tiny"],
    ["small.en", "small"],
    ["q8", "turbo-q8"],
    ["large", "turbo"],
    ["Hebrew", "ivrit"],
    ["turbo-q5", "turbo-q5"],
  ])("accepts the dictation model alias %j as %s", (spoken, model) => {
    expect(decodeConfig({ dictationModel: spoken }).dictationModel).toBe(model);
    expect(() => decodeConfig({ dictationModel: "gigantic" })).toThrow();
  });

  it.each([
    ["agent", "grok"],
    ["agy", "gemini"],
    ["pie", "pi"],
    ["Codex", "codex"],
  ])("accepts the refine provider alias %j as %s", (name, provider) => {
    expect(decodeConfig({ refineProvider: name }).refineProvider).toBe(provider);
  });

  it("accepts a voice in any case and rejects an unknown voice", () => {
    expect(decodeConfig({ speechVoice: "m3" }).speechVoice).toBe("M3");
    expect(() => decodeConfig({ speechVoice: "Z9" })).toThrow();
  });

  it("rejects out-of-range numbers, unknown modes, the dropped local provider, and unknown keys", () => {
    expect(() => decodeConfig({ dictationKeepListeningSeconds: 9 })).toThrow();
    expect(() => decodeConfig({ speechWordsPerMinute: 10 })).toThrow();
    expect(() => decodeConfig({ speechMode: "loud" })).toThrow();
    expect(() => decodeConfig({ refineProvider: "local" })).toThrow();
    expect(() => decodeConfig({ unknownSetting: "off" })).toThrow();
  });

  it("lists every setting with a kebab-case name, a label, a description, and its choices", () => {
    const names = configSettings.map((setting) => setting.name);
    expect(names).toContain("speech-words-per-minute");
    expect(names).toContain("dictation-keep-listening-seconds");
    expect(configSettings.every((setting) => setting.label !== "" && setting.description !== "")).toBe(true);
    expect(configSettings.find((setting) => setting.key === "dictationLanguage")?.choices).toEqual(["en", "he"]);
    expect(configSettings.find((setting) => setting.key === "dictationModel")?.choices).toEqual([
      "auto",
      "tiny",
      "base",
      "small",
      "turbo-q5",
      "turbo-q8",
      "turbo",
      "ivrit",
    ]);
    expect(configSettings.find((setting) => setting.key === "refineEffort")?.optional).toBe(true);
    expect(configSettings.find((setting) => setting.key === "speechVoice")?.choices).toHaveLength(10);
  });

  it("turns CLI text into a setting value and clears an optional setting with empty text", () => {
    const keepListening = configSettings.find((setting) => setting.key === "dictationKeepListeningSeconds");
    const refineModel = configSettings.find((setting) => setting.key === "refineModel");
    if (keepListening === undefined || refineModel === undefined) {
      throw new Error("missing settings");
    }

    const seconds = parseSettingValue({ setting: keepListening, enteredWords: "1" });
    const clearedModel = parseSettingValue({ setting: refineModel, enteredWords: " " });
    const withModel = withSettingValue({
      config: defaultConfig,
      key: "refineModel",
      value: "grok-4.5",
    });
    const cleared = withSettingValue({ config: withModel, key: "refineModel", value: null });

    expect(seconds).toBe(1);
    expect(clearedModel).toBeNull();
    expect(withModel.refineModel).toBe("grok-4.5");
    expect("refineModel" in cleared).toBe(false);
  });
});
