import { readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "#src/testing/test-folder.js";
import { readSettings, readSettingsOrDefaults, saveSettings } from "./config-file.js";
import { defaultSettings } from "./config-schema.js";

let home = "";

// AGENT_VOICE_CONFIG_FILE wins over AGENT_VOICE_HOME, so one set in the developer's shell would point the test at a real file.
beforeEach(() => {
  home = makeTestFolder("config");
  vi.stubEnv("AGENT_VOICE_HOME", home);
  vi.stubEnv("AGENT_VOICE_CONFIG_FILE", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("config file", () => {
  it("reads the defaults when ~/.agent-voice/config.json does not exist yet", () => {
    expect(readSettings()).toEqual(defaultSettings);
  });

  it("writes every setting and reads the same config back", () => {
    const hebrewSettings = { ...defaultSettings, dictationLanguage: "he" as const, refineModel: "grok-4.5" };

    saveSettings(hebrewSettings);
    const settingsPath = path.join(home, "config.json");
    const savedSettingsFileReading = readFileSync(settingsPath, "utf8");

    expect(JSON.parse(savedSettingsFileReading)).toMatchObject({
      dictationLanguage: "he",
      refineModel: "grok-4.5",
      speechVoice: "F4",
    });
    expect(readSettings()).toEqual(hebrewSettings);
  });

  it("fails on a file it cannot read instead of reading the defaults, so `config set` never replaces it", () => {
    // A symlink to itself cannot be read by anyone; a mode-000 file can still be read by root.
    const file = path.join(home, "config.json");
    symlinkSync("config.json", file);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => readSettings()).toThrow();
    expect(readSettingsOrDefaults()).toEqual(defaultSettings);
    expect(readlinkSync(file)).toBe("config.json");
  });

  it("fails on a broken file, while workers fall back to the defaults", () => {
    const settingsPath = path.join(home, "config.json");
    writeFileSync(settingsPath, '{ "speechMode": "loud" }');
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => readSettings()).toThrow();
    expect(readSettingsOrDefaults()).toEqual(defaultSettings);
  });
});
