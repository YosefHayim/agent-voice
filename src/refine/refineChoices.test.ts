import { readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { codexFailedModels, markCodexModelFailed, saveRefineChoice } from "./refineChoices.js";

let home = "";

beforeEach(() => {
  home = makeTestFolder("choices");
  vi.stubEnv("AGENT_VOICE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("Codex failed models", () => {
  it("lists a failed model once, and drops it when that model works again", () => {
    markCodexModelFailed("gpt-5.3-codex-spark");
    markCodexModelFailed("o4-mini");
    markCodexModelFailed("gpt-5.3-codex-spark");
    const failedList = path.join(home, "refine-codex-failed.txt");
    expect(readFileSync(failedList, "utf8")).toBe("gpt-5.3-codex-spark\no4-mini\n");

    saveRefineChoice({ provider: "codex", model: "o4-mini", effort: "low" });
    expect([...codexFailedModels()]).toEqual(["gpt-5.3-codex-spark"]);
  });

  it("never replaces a list it cannot read with one that holds only the latest model", () => {
    // A symlink to itself cannot be read by anyone, root included.
    const failedList = path.join(home, "refine-codex-failed.txt");
    symlinkSync("refine-codex-failed.txt", failedList);

    markCodexModelFailed("gpt-5.3-codex-spark");
    saveRefineChoice({ provider: "codex", model: "o4-mini", effort: "low" });

    expect(readlinkSync(failedList)).toBe("refine-codex-failed.txt");
    expect([...codexFailedModels()]).toEqual([]);
  });
});
