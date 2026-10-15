import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePrivateFolder, writeFileAtomically, writePrivateFile } from "./stateFiles.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let folder = "";
const inheritedVoxkeyHome = process.env.VOXKEY_HOME;

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  folder = mkdtempSync(path.join(scratchRoot, "private-"));
});

afterEach(() => {
  if (inheritedVoxkeyHome === undefined) delete process.env.VOXKEY_HOME;
  else process.env.VOXKEY_HOME = inheritedVoxkeyHome;
  rmSync(folder, { recursive: true, force: true });
});

const permissions = (file: string) => statSync(file).mode & 0o777;

describe("private files", () => {
  it("creates a file only the user can read, in folders only the user can open", () => {
    const audio = path.join(folder, "audio", "speech-1-0.wav");

    writePrivateFile({ path: audio, flags: "w", contents: Uint8Array.from([82, 73, 70, 70]) });

    expect(permissions(audio)).toBe(0o600);
    expect(permissions(path.dirname(audio))).toBe(0o700);
    expect([...readFileSync(audio)]).toEqual([82, 73, 70, 70]);
  });

  it("tightens a file and its folder that were readable by everyone, keeping what they held", () => {
    const prompts = path.join(folder, "prompts");
    const prompt = path.join(prompts, "prompt.txt");
    mkdirSync(prompts);
    writeFileSync(prompt, "first draft\n");
    chmodSync(prompts, 0o755);
    chmodSync(prompt, 0o644);

    writePrivateFile({ path: prompt, flags: "a", contents: "second draft\n" });

    expect(permissions(prompt)).toBe(0o600);
    expect(permissions(prompts)).toBe(0o700);
    expect(readFileSync(prompt, "utf8")).toBe("first draft\nsecond draft\n");
  });

  it("tightens a folder created looser before", () => {
    const inbox = path.join(folder, "inbox");
    mkdirSync(inbox, { mode: 0o755 });
    chmodSync(inbox, 0o777);

    makePrivateFolder(inbox);

    expect(permissions(inbox)).toBe(0o700);
  });

  it("tightens voxkey's own folders on an atomic write, and leaves a folder the user picked as it was", () => {
    const home = path.join(folder, "voxkey-home");
    const chosen = path.join(folder, "dotfiles");
    mkdirSync(home, { mode: 0o755 });
    mkdirSync(chosen, { mode: 0o755 });
    chmodSync(home, 0o755);
    chmodSync(chosen, 0o755);
    process.env.VOXKEY_HOME = home;

    writeFileAtomically({ path: path.join(home, "refine-codex-last-good.txt"), text: "gpt-5\n" });
    writeFileAtomically({ path: path.join(chosen, "voxkey.json"), text: "{}\n" });

    expect(permissions(home)).toBe(0o700);
    expect(permissions(path.join(home, "refine-codex-last-good.txt"))).toBe(0o600);
    expect(permissions(chosen)).toBe(0o755);
  });
});
