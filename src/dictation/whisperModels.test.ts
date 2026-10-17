import { describe, expect, it } from "vitest";

import { type Config, defaultConfig } from "../settings/configSchema.js";
import { readEnvironment } from "../settings/environmentVariables.js";
import { selectWhisperModel } from "./whisperModels.js";

const selectedKey = (request: { readonly forced: string; readonly config: Partial<Config> }) => {
  const environment = { ...readEnvironment(), AGENT_VOICE_DICTATION_MODEL: request.forced };
  const config = { ...defaultConfig, ...request.config };
  return selectWhisperModel({ environment, config }).key;
};

describe("selectWhisperModel", () => {
  it("follows the language when the dictation model is auto", () => {
    expect(selectedKey({ forced: "", config: {} })).toBe("turbo-q5");
    expect(selectedKey({ forced: "", config: { dictationLanguage: "he" } })).toBe("ivrit");
  });

  it("uses the dictation model setting over the language", () => {
    expect(selectedKey({ forced: "", config: { dictationModel: "small" } })).toBe("small");
    expect(selectedKey({ forced: "", config: { dictationModel: "turbo", dictationLanguage: "he" } })).toBe("turbo");
  });

  it("lets AGENT_VOICE_DICTATION_MODEL win over the setting, and an unknown name means turbo-q5", () => {
    expect(selectedKey({ forced: "tiny", config: { dictationModel: "small" } })).toBe("tiny");
    expect(selectedKey({ forced: "nonsense", config: { dictationModel: "small" } })).toBe("turbo-q5");
  });
});
