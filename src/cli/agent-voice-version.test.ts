import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { agentVoiceVersion } from "./agent-voice-version.js";

describe("agentVoiceVersion", () => {
  it("matches the version in package.json", () => {
    const packageDocumentFile = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const packageDocument: { version: string } = JSON.parse(packageDocumentFile);

    expect(agentVoiceVersion).toBe(packageDocument.version);
  });
});
