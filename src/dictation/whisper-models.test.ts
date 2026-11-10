import { describe, expect, it } from "vitest";

import { type Config, defaultConfig } from "#src/settings/config-schema.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { selectWhisperModel } from "./whisper-models.js";

const readSelectedKey = (request: { readonly forced: string; readonly config: Partial<Config> }) => {
  const environment = { ...readEnvironment(), AGENT_VOICE_DICTATION_MODEL: request.forced };
  const config = { ...defaultConfig, ...request.config };
  return selectWhisperModel({ environment, config }).key;
};

describe("selectWhisperModel", () => {
  it("follows the language when the dictation model is auto", () => {
    expect(readSelectedKey({ forced: "", config: {} })).toBe("turbo-q5");
    expect(readSelectedKey({ forced: "", config: { dictationLanguage: "he" } })).toBe("ivrit");
  });

  it("uses the dictation model setting over the language", () => {
    expect(readSelectedKey({ forced: "", config: { dictationModel: "small" } })).toBe("small");
    expect(readSelectedKey({ forced: "", config: { dictationModel: "turbo", dictationLanguage: "he" } })).toBe("turbo");
  });

  it("lets AGENT_VOICE_DICTATION_MODEL win over the setting, and an unknown name means turbo-q5", () => {
    expect(readSelectedKey({ forced: "tiny", config: { dictationModel: "small" } })).toBe("tiny");
    expect(readSelectedKey({ forced: "nonsense", config: { dictationModel: "small" } })).toBe("turbo-q5");
  });
});
