import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentVoice } from "#src/testing/run-agent-voice.js";
import { makeTestFolder } from "#src/testing/test-folder.js";

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

const readAgentVoice = (argumentList: ReadonlyArray<string>) => {
  const { AGENT_VOICE_CONFIG_FILE: _ignored, AGENT_VOICE_DICTATION_MODEL: _forced, ...environment } = process.env;
  return runAgentVoice({
    args: argumentList,
    environment: { ...environment, HOME: home, AGENT_VOICE_HOME: path.join(home, ".agent-voice") },
  });
};

describe("agent-voice config errors", () => {
  it("go to stderr, so stdout carries only the command's own output", async () => {
    const get = await readAgentVoice(["config", "get", "no-such-setting"]);

    expect(get.status).toBe(2);
    expect(get.stdout).toBe("");
    expect(get.stderr).toContain('Unknown setting "no-such-setting"');
  });
});

describe("agent-voice dictation hold key", () => {
  it("persists Right Option and reports it in status", async () => {
    const changed = await readAgentVoice(["config", "set", "dictation-hold-key", "right-option"]);
    expect(changed.status).toBe(0);
    const configured = await readAgentVoice(["config", "get", "dictation-hold-key"]);
    expect(configured.stdout.trim()).toBe('"right-option"');
    const status = await readAgentVoice(["status", "--json"]);
    const parsedStatus = JSON.parse(status.stdout);
    expect(parsedStatus.dictation.hotkey).toBe("hold-right-option");
    expect(parsedStatus.dictation.running).toBe(false);
  });
});

// A stand-in speech worker that writes "stopped" to the marker file when it gets the stop-speech signal.
const startStandInSpeechWorker = async (marker: string) => {
  const listener = `process.on("SIGUSR2", () => { require("node:fs").writeFileSync(process.argv[1], "stopped"); process.exit(0); }); setInterval(() => {}, 1 << 30);`;
  sleeper = spawn(process.execPath, ["-e", listener, marker, "worker", "speech"], { stdio: "ignore" });
  await new Promise((fulfill) => sleeper?.once("spawn", fulfill));
  const agentVoiceFolder = path.join(home, ".agent-voice");
  const pidFile = path.join(agentVoiceFolder, "speech.pid");
  const pid = String(sleeper.pid);
  mkdirSync(agentVoiceFolder, { recursive: true });
  writeFileSync(pidFile, pid);
};

const isSpeechStopped = async (marker: string) => {
  const deadline = Date.now() + 3_000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((fulfill) => setTimeout(fulfill, 50));
  }
  return existsSync(marker) && readFileSync(marker, "utf8") === "stopped";
};

const readSpeechMuted = async () => {
  const statusRun = await readAgentVoice(["status", "--json"]);
  return JSON.parse(statusRun.stdout).speech.muted;
};

describe("agent-voice config set speech-mode off", () => {
  it("stops the reply being read now instead of after it ends", async () => {
    const marker = path.join(home, "stopped");
    await startStandInSpeechWorker(marker);

    const set = await readAgentVoice(["config", "set", "speech-mode", "off"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Speech stops");
    expect(await isSpeechStopped(marker)).toBe(true);
  });
});

describe("agent-voice speech-muted", () => {
  it("starts muted, and config set speech-muted false unmutes", async () => {
    expect(await readSpeechMuted()).toBe(true);

    const set = await readAgentVoice(["config", "set", "speech-muted", "false"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("speech-muted = false");
    expect(await readSpeechMuted()).toBe(false);
  });

  it("stops the reply being read now when muted again", async () => {
    const marker = path.join(home, "stopped");
    await startStandInSpeechWorker(marker);
    const settingsFile = path.join(home, ".agent-voice", "config.json");
    const settingsString = JSON.stringify({ readSpeechMuted: false });
    writeFileSync(settingsFile, settingsString);

    const set = await readAgentVoice(["config", "set", "speech-muted", "true"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Speech muted");
    expect(await isSpeechStopped(marker)).toBe(true);
  });
});

const readDictationStatus = async () => {
  const statusRun = await readAgentVoice(["status", "--json"]);
  return JSON.parse(statusRun.stdout).dictation;
};

describe("agent-voice config set dictation-model", () => {
  it("selects the model, shows it in status --json with its file path, and unset goes back to auto", async () => {
    const before = await readDictationStatus();
    expect(before.modelKey).toBe("turbo-q5");

    const set = await readAgentVoice(["config", "set", "dictation-model", "small.en"]);
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('dictation-model = "small"');
    const get = await readAgentVoice(["config", "get", "dictation-model"]);
    expect(get.stdout).toContain('"small"');

    const after = await readDictationStatus();
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

    const unset = await readAgentVoice(["config", "unset", "dictation-model"]);
    expect(unset.status).toBe(0);
    const reset = await readDictationStatus();
    expect(reset.modelKey).toBe("turbo-q5");
  });
});

describe("agent-voice config describe", () => {
  it("prints every setting with its kind, choices, and value as one JSON document", async () => {
    await readAgentVoice(["config", "set", "speech-voice", "M2"]);
    const described = await readAgentVoice(["config", "describe"]);
    const settings = JSON.parse(described.stdout);
    const voice = settings.find((setting: { name: string }) => setting.name === "speech-voice");
    const effort = settings.find((setting: { name: string }) => setting.name === "refine-effort");
    const muted = settings.find((setting: { name: string }) => setting.name === "speech-muted");

    expect(described.status).toBe(0);
    expect(voice).toMatchObject({ label: "speech voice", kind: "text", optional: false, value: "M2" });
    expect(voice.choices).toContain("F4");
    expect(effort).toMatchObject({ kind: "text", optional: true, value: null });
    expect(effort.choices).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(muted).toMatchObject({ kind: "boolean", choices: ["true", "false"], value: true });
  });
});
