import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentVoice } from "../scripts/runAgentVoice.js";
import { makeTestFolder } from "../scripts/testFolder.js";

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

const agentVoice = (args: ReadonlyArray<string>) => {
  const { AGENT_VOICE_CONFIG_FILE: _ignored, ...environment } = process.env;
  return runAgentVoice({
    args,
    environment: { ...environment, HOME: home, AGENT_VOICE_HOME: path.join(home, ".agent-voice") },
  });
};

describe("agent-voice config errors", () => {
  it("go to stderr, so stdout carries only the command's own output", async () => {
    const get = await agentVoice(["config", "get", "no-such-setting"]);

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
  const agentVoiceFolder = path.join(home, ".agent-voice");
  const pidFile = path.join(agentVoiceFolder, "speech.pid");
  const pid = String(sleeper.pid);
  mkdirSync(agentVoiceFolder, { recursive: true });
  writeFileSync(pidFile, pid);
};

const speechStopped = async (marker: string) => {
  const deadline = Date.now() + 3_000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return existsSync(marker) && readFileSync(marker, "utf8") === "stopped";
};

const speechMuted = async () => {
  const statusRun = await agentVoice(["status", "--json"]);
  return JSON.parse(statusRun.stdout).speech.muted;
};

describe("agent-voice config set speech-mode off", () => {
  it("stops the reply being read now instead of after it ends", async () => {
    const marker = path.join(home, "stopped");
    await startStandInSpeechWorker(marker);

    const set = await agentVoice(["config", "set", "speech-mode", "off"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Speech stops");
    expect(await speechStopped(marker)).toBe(true);
  });
});

describe("agent-voice speech-muted", () => {
  it("starts muted, and config set speech-muted false unmutes", async () => {
    expect(await speechMuted()).toBe(true);

    const set = await agentVoice(["config", "set", "speech-muted", "false"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("speech-muted = false");
    expect(await speechMuted()).toBe(false);
  });

  it("stops the reply being read now when muted again", async () => {
    const marker = path.join(home, "stopped");
    await startStandInSpeechWorker(marker);
    const configFile = path.join(home, ".agent-voice", "config.json");
    const configText = JSON.stringify({ speechMuted: false });
    writeFileSync(configFile, configText);

    const set = await agentVoice(["config", "set", "speech-muted", "true"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Speech muted");
    expect(await speechStopped(marker)).toBe(true);
  });
});

const dictationStatus = async () => {
  const statusRun = await agentVoice(["status", "--json"]);
  return JSON.parse(statusRun.stdout).dictation;
};

describe("agent-voice config set dictation-model", () => {
  it("selects the model, shows it in status --json with its file path, and unset goes back to auto", async () => {
    const before = await dictationStatus();
    expect(before.modelKey).toBe("turbo-q5");

    const set = await agentVoice(["config", "set", "dictation-model", "small.en"]);
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('dictation-model = "small"');
    const get = await agentVoice(["config", "get", "dictation-model"]);
    expect(get.stdout).toContain('"small"');

    const after = await dictationStatus();
    const selected = after.models.filter((model: { selected: boolean }) => model.selected);
    expect(after.modelKey).toBe("small");
    expect(selected.map((model: { key: string }) => model.key)).toEqual(["small"]);
    expect(after.models).toHaveLength(7);
    expect(selected[0]).toEqual({
      key: "small",
      label: "Small English",
      megabytes: 488,
      path: path.join(home, ".agent-voice", "models", "ggml-small.en.bin"),
      present: false,
      selected: true,
    });

    const unset = await agentVoice(["config", "unset", "dictation-model"]);
    expect(unset.status).toBe(0);
    const reset = await dictationStatus();
    expect(reset.modelKey).toBe("turbo-q5");
  });
});
