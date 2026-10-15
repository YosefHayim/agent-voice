import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendDictationLog } from "./workerLog.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let scratch = "";
let home = "";

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  scratch = mkdtempSync(path.join(scratchRoot, "log-"));
  home = path.join(scratch, ".voxkey");
  vi.stubEnv("VOXKEY_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const permissions = (file: string) => statSync(file).mode & 0o777;

describe("dictation.log", () => {
  it("is created readable by the user alone, in a voxkey folder only the user can open", () => {
    appendDictationLog("stt text=meet me at noon");

    expect(permissions(path.join(home, "dictation.log"))).toBe(0o600);
    expect(permissions(home)).toBe(0o700);
    expect(readFileSync(path.join(home, "dictation.log"), "utf8")).toMatch(/^\d+\.\d{3} stt text=meet me at noon\n$/u);
  });

  it("keeps every dictated line, and tightens a log and a folder an older build left readable by others", () => {
    const log = path.join(home, "dictation.log");
    mkdirSync(home);
    writeFileSync(log, "1.000 stt text=an earlier hold\n");
    chmodSync(home, 0o755);
    chmodSync(log, 0o644);

    appendDictationLog("refine text=a refined prompt");

    expect(permissions(log)).toBe(0o600);
    expect(permissions(home)).toBe(0o700);
    expect(readFileSync(log, "utf8").split("\n")).toEqual([
      "1.000 stt text=an earlier hold",
      expect.stringMatching(/^\d+\.\d{3} refine text=a refined prompt$/u),
      "",
    ]);
  });
});
