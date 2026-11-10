import { describe, expect, it } from "vitest";

import {
  decodeSettings,
  defaultSettings,
  parseSettingField,
  setSettingField,
  settingDefinitions,
} from "./config-schema.js";

describe("configSchema", () => {
  it("decodes an empty file to the documented defaults", () => {
    expect(defaultSettings).toEqual({
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
    expect(decodeSettings({ dictationHoldKey: "right-option" }).dictationHoldKey).toBe("right-option");
    expect(() => decodeSettings({ dictationHoldKey: "left-option" })).toThrow();
    expect(() => decodeSettings({ dictationHoldKey: "command-s" })).toThrow();
  });

  it.each([
    ["Hebrew", "he"],
    [" ivrit ", "he"],
    ["iw", "he"],
    ["lang=he", "he"],
    ["English", "en"],
    ["EN-US", "en"],
  ])("accepts the dictation language alias %j as %s", (spoken, language) => {
    expect(decodeSettings({ dictationLanguage: spoken }).dictationLanguage).toBe(language);
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
    expect(decodeSettings({ dictationModel: spoken }).dictationModel).toBe(model);
    expect(() => decodeSettings({ dictationModel: "gigantic" })).toThrow();
  });

  it.each([
    ["agent", "grok"],
    ["agy", "gemini"],
    ["pie", "pi"],
    ["Codex", "codex"],
  ])("accepts the refine provider alias %j as %s", (name, provider) => {
    expect(decodeSettings({ refineProvider: name }).refineProvider).toBe(provider);
  });

  it("accepts a voice in any case and rejects an unknown voice", () => {
    expect(decodeSettings({ speechVoice: "m3" }).speechVoice).toBe("M3");
    expect(() => decodeSettings({ speechVoice: "Z9" })).toThrow();
  });

  it("rejects out-of-range numbers, unknown modes, the dropped local provider, and unknown keys", () => {
    expect(() => decodeSettings({ dictationKeepListeningSeconds: 9 })).toThrow();
    expect(() => decodeSettings({ speechWordsPerMinute: 10 })).toThrow();
    expect(() => decodeSettings({ speechMode: "loud" })).toThrow();
    expect(() => decodeSettings({ refineProvider: "local" })).toThrow();
    expect(() => decodeSettings({ unknownSetting: "off" })).toThrow();
  });

  it("lists every setting with a kebab-case name, a label, a description, and its choices", () => {
    const names = settingDefinitions.map((setting) => setting.name);
    expect(names).toContain("speech-words-per-minute");
    expect(names).toContain("dictation-keep-listening-seconds");
    expect(settingDefinitions.every((setting) => setting.label !== "" && setting.description !== "")).toBe(true);
    expect(settingDefinitions.find((setting) => setting.key === "dictationLanguage")?.choices).toEqual(["en", "he"]);
    expect(settingDefinitions.find((setting) => setting.key === "dictationModel")?.choices).toEqual([
      "auto",
      "tiny",
      "base",
      "small",
      "turbo-q5",
      "turbo-q8",
      "turbo",
      "ivrit",
    ]);
    expect(settingDefinitions.find((setting) => setting.key === "refineEffort")?.optional).toBe(true);
    expect(settingDefinitions.find((setting) => setting.key === "speechVoice")?.choices).toHaveLength(10);
  });

  it("turns CLI text into a setting value and clears an optional setting with empty text", () => {
    const keepListening = settingDefinitions.find((setting) => setting.key === "dictationKeepListeningSeconds");

    const refineModel = settingDefinitions.find((setting) => setting.key === "refineModel");

    const isSettingsIncomplete = keepListening == null || refineModel == null;
    if (isSettingsIncomplete) {
      throw new Error("missing settings");
    }

    const seconds = parseSettingField({ setting: keepListening, enteredWords: "1" });
    const clearedModel = parseSettingField({ setting: refineModel, enteredWords: " " });
    const withModel = setSettingField({
      config: defaultSettings,
      key: "refineModel",
      value: "grok-4.5",
    });
    const cleared = setSettingField({ config: withModel, key: "refineModel", value: null });

    expect(seconds).toBe(1);
    expect(clearedModel).toBeNull();
    expect(withModel.refineModel).toBe("grok-4.5");
    expect("refineModel" in cleared).toBe(false);
  });
});
