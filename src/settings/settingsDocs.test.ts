import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { configSettings } from "./configSchema.js";
import { voxkeyVariables } from "./environmentVariables.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const exampleVariables = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

describe("settings docs", () => {
  it("README documents every setting with its own description in its own row", () => {
    const rows = readme.split("\n");
    for (const setting of configSettings) {
      const description = setting.description.replaceAll("|", "\\|");
      const documented = rows.some(
        (line) => line.startsWith(`| \`${setting.name}\` |`) && line.includes(` | ${description} |`),
      );
      expect(documented, setting.name).toBe(true);
    }
  });

  it("README documents every VOXKEY_* variable", () => {
    expect(voxkeyVariables.length).toBe(5);
    for (const variable of voxkeyVariables) {
      expect(readme).toContain(`| \`${variable.name}\` |`);
    }
  });

  it(".env.example lists every VOXKEY_* variable, empty, under its own description", () => {
    const assignments = exampleVariables.split("\n").filter((line) => /^[A-Z_]+=/u.test(line));

    expect(assignments.length).toBe(voxkeyVariables.length);
    for (const variable of voxkeyVariables) {
      expect(exampleVariables).toContain(`# ${variable.description}\n${variable.name}=\n`);
    }
  });
});
