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

import { runAgentVoice } from "#src/testing/run-agent-voice.js";
import { makeTestFolder } from "#src/testing/test-folder.js";

let home = "";
let psLog = "";

const claudeSettings =
  '{\n  // keep this comment\n  "model": "opus",\n  "hooks": {\n    "Stop": [{"hooks": [{"type": "command", "command": "notify"}]}]\n  }\n}\n';

const codexHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"guard"}]}]}}\n';

const createHomePath = (relative: string) => path.join(home, relative);

const read = (relative: string) => {
  const file = createHomePath(relative);
  return readFileSync(file, "utf8");
};

const write = (relative: string, messages: string) => {
  const file = createHomePath(relative);
  writeFileSync(file, messages);
};

const hasFile = (relative: string) => {
  const file = createHomePath(relative);
  return existsSync(file);
};

const remove = (relative: string) => {
  const file = createHomePath(relative);
  rmSync(file, { recursive: true });
};

const makeFolder = (relative: string) => {
  const folder = createHomePath(relative);
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
  psLog = createHomePath("ps.log");
  const psScript = createHomePath("bin/ps");
  writeFileSync(psScript, `#!/bin/sh\necho "$@" >> '${psLog}'\n`, { mode: 0o755 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// CLAUDE_CONFIG_DIR is cleared unless a test sets it, so a run inside Claude Code never edits the developer's own settings.
const readAgentVoice = (argumentList: ReadonlyArray<string>, claudeSettingsFolder = "") =>
  runAgentVoice({
    args: argumentList,
    environment: {
      ...process.env,
      HOME: home,
      AGENT_VOICE_HOME: createHomePath(".agent-voice"),
      CLAUDE_CONFIG_DIR: claudeSettingsFolder,
      PATH: `${createHomePath("bin")}:${process.env.PATH || ""}`,
    },
  });

describe("agent-voice on --hooks-only and agent-voice off in a scratch HOME", () => {
  it("keeps settings backups private, tightening a backups folder an older build left open", async () => {
    const agentVoiceFolder = createHomePath(".agent-voice");
    const backups = createHomePath(".agent-voice/backups");
    const claudeSettingsFile = createHomePath(".claude/settings.json");
    mkdirSync(backups, { recursive: true });
    chmodSync(agentVoiceFolder, 0o755);
    chmodSync(backups, 0o755);
    chmodSync(claudeSettingsFile, 0o644);

    const on = await readAgentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);

    const readPermissions = (file: string) => statSync(file).mode & 0o777;
    expect(readPermissions(agentVoiceFolder)).toBe(0o700);
    expect(readPermissions(backups)).toBe(0o700);
    for (const backup of readdirSync(backups)) {
      const backupFile = path.join(backups, backup);
      expect(readPermissions(backupFile)).toBe(0o600);
    }
    expect(readPermissions(claudeSettingsFile)).toBe(0o644);
  });

  it("adds one reply hook per installed agent, backs files up, and removes exactly what it added", async () => {
    const backups = createHomePath(".agent-voice/backups");
    const on = await readAgentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(read(".claude/settings.json")).toContain("// keep this comment");
    expect(read(".claude/settings.json")).toContain("reply --agent claude-code");
    expect(read(".codex/hooks.json")).toContain("reply --agent codex");
    expect(read(".grok/hooks/agent-voice.json")).toContain("reply --agent grok");
    expect(readdirSync(backups)).toHaveLength(2);

    const again = await readAgentVoice(["on", "--hooks-only"]);
    expect(again.stdout).toContain("already registered");
    expect(read(".claude/settings.json").match(/reply --agent claude-code/gu)).toHaveLength(1);

    const statusRun = await readAgentVoice(["status", "--json"]);
    const status = JSON.parse(statusRun.stdout);
    expect(status.hooks).toEqual(["claude-code", "codex", "grok"]);

    const off = await readAgentVoice(["off"]);
    expect(off.status).toBe(0);
    expect(readFileSync(psLog, "utf8")).toContain("-ax");
    expect(read(".claude/settings.json")).toBe(claudeSettings);
    expect(read(".codex/hooks.json")).toBe(codexHooks);
    expect(hasFile(".grok/hooks/agent-voice.json")).toBe(false);
  });

  it("adds the hook in every Claude Code config folder, replaces an entry left by a moved install, and removes it all without CLAUDE_CONFIG_DIR", async () => {
    const staleHook =
      "'/usr/local/bin/node' '/missing/node_modules/voxkey/dist/src/cli/main.js' reply --agent claude-code";
    const staleSettings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: staleHook }] }] } });
    makeFolder(".claude-work");
    write(".claude-work/settings.json", staleSettings);
    makeFolder(".claude-notes");
    makeFolder("work/.claude");
    const customFolder = createHomePath("work/.claude");
    const backups = createHomePath(".agent-voice/backups");

    const on = await readAgentVoice(["on", "--hooks-only"], customFolder);
    expect(on.status).toBe(0);
    expect(read(".claude/settings.json")).toContain("reply --agent claude-code");
    expect(read(".claude-work/settings.json").match(/reply --agent claude-code/gu)).toHaveLength(1);
    expect(read(".claude-work/settings.json")).not.toContain("voxkey");
    expect(read("work/.claude/settings.json")).toContain("reply --agent claude-code");
    expect(hasFile(".claude-notes/settings.json")).toBe(false);
    expect(readdirSync(backups)).toHaveLength(3);

    const statusRun = await readAgentVoice(["status", "--json"]);
    const status = JSON.parse(statusRun.stdout);
    expect(status.hooks).toEqual(["claude-code", "codex", "grok"]);

    const off = await readAgentVoice(["off"]);
    expect(off.status).toBe(0);
    expect(read(".claude/settings.json")).toBe(claudeSettings);
    expect(read(".claude-work/settings.json")).not.toContain("reply --agent");
    expect(hasFile("work/.claude/settings.json")).toBe(false);
  });

  it("deletes a settings file agent-voice created once it is empty again, and keeps an empty file that was there before", async () => {
    remove(".codex/hooks.json");
    remove(".claude/settings.json");
    write(".grok/other.json", "{}\n");

    const firstOn = await readAgentVoice(["on", "--hooks-only"]);
    expect(firstOn.status).toBe(0);
    expect(read(".codex/hooks.json")).toContain("reply --agent codex");
    expect(read(".claude/settings.json")).toContain("reply --agent claude-code");

    const firstOff = await readAgentVoice(["off"]);
    expect(firstOff.status).toBe(0);
    expect(hasFile(".codex/hooks.json")).toBe(false);
    expect(hasFile(".claude/settings.json")).toBe(false);
    expect(read(".grok/other.json")).toBe("{}\n");

    write(".codex/hooks.json", "{}\n");
    const secondOn = await readAgentVoice(["on", "--hooks-only"]);
    expect(secondOn.status).toBe(0);
    const secondOff = await readAgentVoice(["off"]);
    expect(secondOff.status).toBe(0);
    expect(read(".codex/hooks.json")).toBe("{}\n");
  });

  it("leaves a settings file it cannot read exactly as it is, instead of replacing it", async () => {
    // A symlink to itself cannot be read by anyone; a mode-000 file can still be read by root.
    const settings = createHomePath(".claude/settings.json");
    const backups = createHomePath(".agent-voice/backups");
    rmSync(settings);
    symlinkSync("settings.json", settings);

    const on = await readAgentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("could not be read");
    expect(readlinkSync(settings)).toBe("settings.json");
    expect(readdirSync(backups)).toEqual([expect.stringMatching(/^codex-/u)]);
  });

  it("does not claim there is no hook when the only agent's settings could not be read", async () => {
    remove(".codex");
    remove(".grok");
    const settings = createHomePath(".claude/settings.json");
    rmSync(settings);
    symlinkSync("settings.json", settings);

    const on = await readAgentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("No agent hook was confirmed as registered");
    expect(on.stdout).not.toContain("No agent hook is registered");
  });

  it("does not claim hooks are registered when no agent is installed", async () => {
    remove(".claude");
    remove(".codex");
    remove(".grok");

    const on = await readAgentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("No agent hook was confirmed as registered");
    expect(on.stdout).not.toContain("Hooks registered");
  });

  it("skips agents that are not installed and leaves a broken settings file alone", async () => {
    remove(".grok");
    write(".codex/hooks.json", "{ not json");

    const on = await readAgentVoice(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("Grok: not installed, skipped");
    expect(on.stdout).toContain("left unchanged");
    expect(read(".codex/hooks.json")).toBe("{ not json");
  });
});
