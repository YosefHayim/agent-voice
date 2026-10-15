import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { makePrivateFolder, writeFileAtomically, writePrivateFile } from "./stateFiles.js";

let folder = "";

beforeEach(() => {
  folder = makeTestFolder("private");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});

const permissions = (file: string) => statSync(file).mode & 0o777;

describe("private files", () => {
  it("creates a file only the user can read, in folders only the user can open", () => {
    const audioFolder = path.join(folder, "audio");
    const audio = path.join(audioFolder, "speech-1-0.wav");
    const wavStart = Uint8Array.from([82, 73, 70, 70]);

    writePrivateFile({ path: audio, flags: "w", contents: wavStart });

    expect(permissions(audio)).toBe(0o600);
    expect(permissions(audioFolder)).toBe(0o700);
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
    const lastGood = path.join(home, "refine-codex-last-good.txt");
    const chosenConfig = path.join(chosen, "voxkey.json");
    mkdirSync(home, { mode: 0o755 });
    mkdirSync(chosen, { mode: 0o755 });
    chmodSync(home, 0o755);
    chmodSync(chosen, 0o755);
    vi.stubEnv("VOXKEY_HOME", home);

    writeFileAtomically({ path: lastGood, text: "gpt-5\n" });
    writeFileAtomically({ path: chosenConfig, text: "{}\n" });

    expect(permissions(home)).toBe(0o700);
    expect(permissions(lastGood)).toBe(0o600);
    expect(permissions(chosen)).toBe(0o755);
  });
});
