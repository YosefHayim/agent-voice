import { readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { readConfig, readConfigOrDefaults, saveConfig } from "./configFile.js";
import { defaultConfig } from "./configSchema.js";

let home = "";

// VOXKEY_CONFIG_FILE wins over VOXKEY_HOME, so one set in the developer's shell would point the test at a real file.
beforeEach(() => {
  home = makeTestFolder("config");
  vi.stubEnv("VOXKEY_HOME", home);
  vi.stubEnv("VOXKEY_CONFIG_FILE", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("config file", () => {
  it("reads the defaults when ~/.voxkey/config.json does not exist yet", () => {
    expect(Effect.runSync(readConfig)).toEqual(defaultConfig);
  });

  it("writes every setting and reads the same config back", () => {
    const config = { ...defaultConfig, dictationLanguage: "he" as const, refineModel: "grok-4.5" };
    saveConfig(config).pipe(Effect.runSync);
    const configPath = path.join(home, "config.json");
    const savedText = readFileSync(configPath, "utf8");

    expect(JSON.parse(savedText)).toMatchObject({
      dictationLanguage: "he",
      refineModel: "grok-4.5",
      speechVoice: "F4",
    });
    expect(Effect.runSync(readConfig)).toEqual(config);
  });

  it("fails on a file it cannot read instead of reading the defaults, so `config set` never replaces it", () => {
    // A symlink to itself cannot be read by anyone; a mode-000 file can still be read by root.
    const file = path.join(home, "config.json");
    symlinkSync("config.json", file);
    const exit = Effect.runSyncExit(readConfig);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(Effect.runSync(readConfigOrDefaults)).toEqual(defaultConfig);
    expect(readlinkSync(file)).toBe("config.json");
  });

  it("fails on a broken file, while workers fall back to the defaults", () => {
    const configPath = path.join(home, "config.json");
    writeFileSync(configPath, '{ "speechMode": "loud" }');
    const exit = Effect.runSyncExit(readConfig);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(Effect.runSync(readConfigOrDefaults)).toEqual(defaultConfig);
  });
});
