import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { agentVoiceVersion } from "./agent-voice-version.js";

describe("agentVoiceVersion", () => {
  it("matches the version in package.json", () => {
    const packageDocumentString = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const packageDocument: { version: string } = JSON.parse(packageDocumentString);

    expect(agentVoiceVersion).toBe(packageDocument.version);
  });
});
