import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { agentVoiceVersion } from "./agentVoiceVersion.js";

describe("agentVoiceVersion", () => {
  it("matches the version in package.json", () => {
    const packageText = readFileSync(new URL("../../package.json", import.meta.url), "utf8");

    expect(packageText).toContain(`"version": "${agentVoiceVersion}"`);
  });
});
