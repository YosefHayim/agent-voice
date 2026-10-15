import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestFolder, repositoryRoot } from "../scripts/testFolder.js";

const mainScript = path.join(repositoryRoot, "src", "cli", "main.ts");

let home = "";
let sleeper: ChildProcess | undefined;

beforeEach(() => {
  home = makeTestFolder("config-cli");
});

// The only process signalled is the stand-in speech worker this test started.
afterEach(() => {
  sleeper?.kill("SIGKILL");
  sleeper = undefined;
  rmSync(home, { recursive: true, force: true });
});

const voxkey = (args: ReadonlyArray<string>) => {
  const { VOXKEY_CONFIG_FILE: _ignored, ...environment } = process.env;
  return spawnSync(process.execPath, ["--import", "tsx", mainScript, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...environment, HOME: home, VOXKEY_HOME: path.join(home, ".voxkey") },
  });
};

describe("voxkey config errors", () => {
  it("go to stderr, so stdout carries only the command's own output", () => {
    const get = voxkey(["config", "get", "no-such-setting"]);

    expect(get.status).toBe(2);
    expect(get.stdout).toBe("");
    expect(get.stderr).toContain('Unknown setting "no-such-setting"');
  });
});

// A stand-in speech worker that writes "stopped" to the marker file when it gets the stop-speech signal.
const startStandInSpeechWorker = async (marker: string) => {
  const listener = `process.on("SIGUSR2", () => { require("node:fs").writeFileSync(process.argv[1], "stopped"); process.exit(0); }); setInterval(() => {}, 1 << 30);`;
  sleeper = spawn(process.execPath, ["-e", listener, marker, "worker", "speech"], { stdio: "ignore" });
  await new Promise((resolve) => sleeper?.once("spawn", resolve));
  const voxkeyFolder = path.join(home, ".voxkey");
  const pidFile = path.join(voxkeyFolder, "speech.pid");
  const pid = String(sleeper.pid);
  mkdirSync(voxkeyFolder, { recursive: true });
  writeFileSync(pidFile, pid);
};

const speechStopped = async (marker: string) => {
  const deadline = Date.now() + 3_000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return existsSync(marker) && readFileSync(marker, "utf8") === "stopped";
};

const speechMuted = () => {
  const statusRun = voxkey(["status", "--json"]);
  return JSON.parse(statusRun.stdout).speech.muted;
};

describe("voxkey config set speech-mode off", () => {
  it("stops the reply being read now instead of after it ends", async () => {
    const marker = path.join(home, "stopped");
    await startStandInSpeechWorker(marker);

    const set = voxkey(["config", "set", "speech-mode", "off"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Speech stops");
    expect(await speechStopped(marker)).toBe(true);
  });
});

describe("voxkey speech-muted", () => {
  it("starts muted, and config set speech-muted false unmutes", () => {
    expect(speechMuted()).toBe(true);

    const set = voxkey(["config", "set", "speech-muted", "false"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("speech-muted = false");
    expect(speechMuted()).toBe(false);
  });

  it("stops the reply being read now when muted again", async () => {
    const marker = path.join(home, "stopped");
    await startStandInSpeechWorker(marker);
    const configFile = path.join(home, ".voxkey", "config.json");
    const configText = JSON.stringify({ speechMuted: false });
    writeFileSync(configFile, configText);

    const set = voxkey(["config", "set", "speech-muted", "true"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Speech muted");
    expect(await speechStopped(marker)).toBe(true);
  });
});
