import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { agentVoiceVersion } from "./agent-voice-version.js";

describe("agentVoiceVersion", () => {
  it("matches the version in package.json", () => {
    const packageJsonText = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const packageJson: { version: string } = JSON.parse(packageJsonText);

    expect(agentVoiceVersion).toBe(packageJson.version);
  });
});
