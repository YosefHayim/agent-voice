import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { expandCommandTemplate, quoteShellWord, readSurfaceParameters, readWorkspaceTitle } from "./cmux-delivery.js";

describe("cmux delivery", () => {
  it("quotes apostrophes for a single-quoted shell string", () => {
    expect(quoteShellWord("it's")).toBe("'it'\\''s'");
  });

  it("expands each placeholder to one shell-quoted word", () => {
    expect(
      expandCommandTemplate({
        template: 'cd {{cwd}} && codex --yolo -- "$(cat {{prompt_file}})" {{prompt}}',
        prompt: "it's",
        promptFile: "/x/p.txt",
        folder: "/cwd",
      }),
    ).toBe(`cd '/cwd' && codex --yolo -- "$(cat '/x/p.txt')" 'it'\\''s'`);
  });

  it("keeps a folder with spaces or `$(...)` as one literal argument, and never expands a placeholder in the prompt", () => {
    const command = expandCommandTemplate({
      template: "printf '%s|' {{cwd}} {{prompt}}",
      prompt: "use {{cwd}} here",
      promptFile: "/x/p.txt",
      folder: "/Users/me/My Repo/$(echo injected)",
    });
    const shell = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

    expect(shell.stdout).toBe("/Users/me/My Repo/$(echo injected)|use {{cwd}} here|");
  });

  it("addresses a surface by ref or by ID", () => {
    expect(readSurfaceParameters("surface:3", { key: "enter" })).toEqual({ surface_ref: "surface:3", key: "enter" });
    expect(readSurfaceParameters("ab-12", {})).toEqual({ surface_id: "ab-12" });
  });

  it("titles a new workspace with the first line of the prompt", () => {
    expect(readWorkspaceTitle("Fix the login bug\nand more")).toBe("refine: Fix the login bug");
    expect(readWorkspaceTitle("")).toBe("refine");
  });
});
