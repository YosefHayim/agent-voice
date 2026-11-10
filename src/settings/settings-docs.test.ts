import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { settingDefinitions } from "./config-schema.js";
import { agentVoiceVariables } from "./environment-variables.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const exampleVariables = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

describe("settings docs", () => {
  it("README documents every setting with its own description in its own row", () => {
    const storedList = readme.split("\n");
    for (const setting of settingDefinitions) {
      const description = setting.description.replaceAll("|", "\\|");
      const documented = storedList.some(
        (line) => line.startsWith(`| \`${setting.name}\` |`) && line.includes(` | ${description} |`),
      );
      expect(documented, setting.name).toBe(true);
    }
  });

  it("README documents every AGENT_VOICE_* variable", () => {
    expect(agentVoiceVariables.length).toBe(5);
    for (const variable of agentVoiceVariables) {
      expect(readme).toContain(`| \`${variable.name}\` |`);
    }
  });

  it(".env.example lists every AGENT_VOICE_* variable, empty, under its own description", () => {
    const assignments = exampleVariables.split("\n").filter((line) => /^[A-Z_]+=/u.test(line));

    expect(assignments.length).toBe(agentVoiceVariables.length);
    for (const variable of agentVoiceVariables) {
      expect(exampleVariables).toContain(`# ${variable.description}\n${variable.name}=\n`);
    }
  });
});
