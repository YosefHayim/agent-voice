import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readConfig, readConfigOrDefaults, saveConfig } from "./configFile.js";
import { defaultConfig } from "./configSchema.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";

// VOXKEY_CONFIG_FILE wins over VOXKEY_HOME, so one set in the developer's shell would point the test at a real file.
beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "config-"));
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
    Effect.runSync(saveConfig(config));

    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toMatchObject({
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

    expect(Exit.isFailure(Effect.runSyncExit(readConfig))).toBe(true);
    expect(Effect.runSync(readConfigOrDefaults)).toEqual(defaultConfig);
    expect(readlinkSync(file)).toBe("config.json");
  });

  it("fails on a broken file, while workers fall back to the defaults", () => {
    writeFileSync(path.join(home, "config.json"), '{ "speechMode": "loud" }');

    expect(Exit.isFailure(Effect.runSyncExit(readConfig))).toBe(true);
    expect(Effect.runSync(readConfigOrDefaults)).toEqual(defaultConfig);
  });
});
