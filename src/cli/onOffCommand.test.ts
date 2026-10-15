import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentVoice } from "../scripts/runAgentVoice.js";
import { makeTestFolder } from "../scripts/testFolder.js";

let home = "";
let psLog = "";

const claudeSettings =
  '{\n  // keep this comment\n  "model": "opus",\n  "hooks": {\n    "Stop": [{"hooks": [{"type": "command", "command": "notify"}]}]\n  }\n}\n';

const codexHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"guard"}]}]}}\n';

const inHome = (relative: string) => path.join(home, relative);

const read = (relative: string) => {
  const file = inHome(relative);
  return readFileSync(file, "utf8");
};

const write = (relative: string, contents: string) => {
  const file = inHome(relative);
  writeFileSync(file, contents);
};

const exists = (relative: string) => {
  const file = inHome(relative);
  return existsSync(file);
};

const remove = (relative: string) => {
  const file = inHome(relative);
  rmSync(file, { recursive: true });
};

const makeFolder = (relative: string) => {
  const folder = inHome(relative);
  mkdirSync(folder, { recursive: true });
};

beforeEach(() => {
  home = makeTestFolder("on-off");
  makeFolder(".claude");
  makeFolder(".codex");
  makeFolder(".grok");
  write(".claude/settings.json", claudeSettings);
  write(".codex/hooks.json", codexHooks);
  // `off` sweeps agent-voice workers by command line across the whole Mac; this ps lists none, so the test never
  // signals a process it did not start (an agent-voice the developer is running keeps running).
  makeFolder("bin");
  psLog = inHome("ps.log");
  const psScript = inHome("bin/ps");
  writeFileSync(psScript, `#!/bin/sh\necho "$@" >> '${psLog}'\n`, { mode: 0o755 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const agentVoice = (args: ReadonlyArray<string>) =>
  runAgentVoice({
    args,
    environment: {
      ...process.env,
      HOME: home,
      AGENT_VOICE_HOME: inHome(".agent-voice"),
      PATH: `${inHome("bin")}:${process.env.PATH || ""}`,
    },
  });

describe("agent-voice on --hooks-only and agent-voice off in a scratch HOME", () => {
  it("keeps settings backups private, tightening a backups folder an older build left open", async () => {
    const agentVoiceFolder = inHome(".agent-voice");
    const backups = inHome(".agent-voice/backups");
    const claudeSettingsFile = inHome(".claude/settings.json");
    mkdirSync(backups, { recursive: true });
    chmodSync(agentVoiceFolder, 0o755);
    chmodSync(backups, 0o755);
    chmodSync(claudeSettingsFile, 0o644);

    const on = await agentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);

    const permissions = (file: string) => statSync(file).mode & 0o777;
    expect(permissions(agentVoiceFolder)).toBe(0o700);
    expect(permissions(backups)).toBe(0o700);
    for (const backup of readdirSync(backups)) {
      const backupFile = path.join(backups, backup);
      expect(permissions(backupFile)).toBe(0o600);
    }
    expect(permissions(claudeSettingsFile)).toBe(0o644);
  });

  it("adds one reply hook per installed agent, backs files up, and removes exactly what it added", async () => {
    const backups = inHome(".agent-voice/backups");
    const on = await agentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(read(".claude/settings.json")).toContain("// keep this comment");
    expect(read(".claude/settings.json")).toContain("reply --agent claude-code");
    expect(read(".codex/hooks.json")).toContain("reply --agent codex");
    expect(read(".grok/hooks/agent-voice.json")).toContain("reply --agent grok");
    expect(readdirSync(backups)).toHaveLength(2);

    const again = await agentVoice(["on", "--hooks-only"]);
    expect(again.stdout).toContain("already registered");
    expect(read(".claude/settings.json").match(/reply --agent claude-code/gu)).toHaveLength(1);

    const statusRun = await agentVoice(["status", "--json"]);
    const status = JSON.parse(statusRun.stdout);
    expect(status.hooks).toEqual(["claude-code", "codex", "grok"]);

    const off = await agentVoice(["off"]);
    expect(off.status).toBe(0);
    expect(readFileSync(psLog, "utf8")).toContain("-ax");
    expect(read(".claude/settings.json")).toBe(claudeSettings);
    expect(read(".codex/hooks.json")).toBe(codexHooks);
    expect(exists(".grok/hooks/agent-voice.json")).toBe(false);
  });

  it("deletes a settings file agent-voice created once it is empty again, and keeps an empty file that was there before", async () => {
    remove(".codex/hooks.json");
    remove(".claude/settings.json");
    write(".grok/other.json", "{}\n");

    const firstOn = await agentVoice(["on", "--hooks-only"]);
    expect(firstOn.status).toBe(0);
    expect(read(".codex/hooks.json")).toContain("reply --agent codex");
    expect(read(".claude/settings.json")).toContain("reply --agent claude-code");

    const firstOff = await agentVoice(["off"]);
    expect(firstOff.status).toBe(0);
    expect(exists(".codex/hooks.json")).toBe(false);
    expect(exists(".claude/settings.json")).toBe(false);
    expect(read(".grok/other.json")).toBe("{}\n");

    write(".codex/hooks.json", "{}\n");
    const secondOn = await agentVoice(["on", "--hooks-only"]);
    expect(secondOn.status).toBe(0);
    const secondOff = await agentVoice(["off"]);
    expect(secondOff.status).toBe(0);
    expect(read(".codex/hooks.json")).toBe("{}\n");
  });

  it("leaves a settings file it cannot read exactly as it is, instead of replacing it", async () => {
    // A symlink to itself cannot be read by anyone; a mode-000 file can still be read by root.
    const settings = inHome(".claude/settings.json");
    const backups = inHome(".agent-voice/backups");
    rmSync(settings);
    symlinkSync("settings.json", settings);

    const on = await agentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("could not be read");
    expect(readlinkSync(settings)).toBe("settings.json");
    expect(readdirSync(backups)).toEqual([expect.stringMatching(/^codex-/u)]);
  });

  it("does not claim there is no hook when the only agent's settings could not be read", async () => {
    remove(".codex");
    remove(".grok");
    const settings = inHome(".claude/settings.json");
    rmSync(settings);
    symlinkSync("settings.json", settings);

    const on = await agentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("No agent hook was confirmed as registered");
    expect(on.stdout).not.toContain("No agent hook is registered");
  });

  it("does not claim hooks are registered when no agent is installed", async () => {
    remove(".claude");
    remove(".codex");
    remove(".grok");

    const on = await agentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("No agent hook was confirmed as registered");
    expect(on.stdout).not.toContain("Hooks registered");
  });

  it("skips agents that are not installed and leaves a broken settings file alone", async () => {
    remove(".grok");
    write(".codex/hooks.json", "{ not json");

    const on = await agentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("Grok: not installed, skipped");
    expect(on.stdout).toContain("left unchanged");
    expect(read(".codex/hooks.json")).toBe("{ not json");
  });
});
