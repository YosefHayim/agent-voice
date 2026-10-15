import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { configSettings } from "./configSchema.js";
import { environmentVariableNames } from "./environmentVariables.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README", () => {
  it("documents every setting with its own description in its own row", () => {
    const rows = readme.split("\n");
    for (const setting of configSettings) {
      const description = setting.description.replaceAll("|", "\\|");
      const documented = rows.some(
        (line) => line.startsWith(`| \`${setting.name}\` |`) && line.includes(` | ${description} |`),
      );
      expect(documented, setting.name).toBe(true);
    }
  });

  it("documents every VOXKEY_* environment variable", () => {
    expect(environmentVariableNames.length).toBe(5);
    for (const name of environmentVariableNames) {
      expect(readme).toContain(`| \`${name}\` |`);
    }
  });
});
