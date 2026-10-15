import { spawnSync } from "node:child_process";

import { Either } from "effect";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import {
  addReplyHook,
  isEmptySettings,
  isReplyHookCommand,
  removeReplyHook,
  replyHookCommand,
} from "./hookSettings.js";

const command = replyHookCommand({
  nodePath: "/usr/local/bin/node",
  scriptArguments: ["/Users/me/Code/agent-voice/dist/src/cli/main.js"],
  agent: "codex",
});

const added = (source: string, hookCommand = command) =>
  addReplyHook({ source, command: hookCommand, agent: "codex" }).pipe(Either.getOrThrow);

const removed = (source: string) => removeReplyHook({ source, agent: "codex" }).pipe(Either.getOrThrow);

const stopCommands = (source: string): ReadonlyArray<string> =>
  (parse(source)?.hooks?.Stop || []).flatMap((group: { hooks: ReadonlyArray<{ command: string }> }) =>
    group.hooks.map((hook) => hook.command),
  );

const claudeSettings = `{
  // my settings
  "model": "opus",
  "hooks": {
    "PreToolUse": [{"matcher":"Write","hooks":[{"type":"command","command":"guard"}]}],
    "Stop": [
      {"hooks": [{"type": "command", "command": "notify-send done"}]}
    ]
  },
  "theme": "dark"
}
`;

describe("replyHookCommand", () => {
  it("quotes paths and ends with the agent, which is how agent-voice finds its own entry", () => {
    expect(command).toBe("'/usr/local/bin/node' '/Users/me/Code/agent-voice/dist/src/cli/main.js' reply --agent codex");
    expect(isReplyHookCommand(command, "codex")).toBe(true);
    expect(isReplyHookCommand(command, "grok")).toBe(false);
    expect(isReplyHookCommand("notify-send done", "codex")).toBe(false);
  });

  it("passes paths to the shell literally, even with quotes, spaces, and command substitution", () => {
    const script = "/Users/o'neil/My Code/$(echo injected)/agent-voice/src/cli/main.ts";
    const hook = replyHookCommand({
      nodePath: "/bin/echo",
      scriptArguments: ["--import", "tsx", script],
      agent: "grok",
    });
    const shell = spawnSync("/bin/sh", ["-c", hook], { encoding: "utf8" });

    expect(shell.stdout).toBe(`--import tsx ${script} reply --agent grok\n`);
    expect(isReplyHookCommand(hook, "grok")).toBe(true);
  });

  it("never claims another tool's Stop hook that only mentions agent-voice or the same arguments", () => {
    expect(isReplyHookCommand("notify-send agent-voice reply --agent codex", "codex")).toBe(false);
    expect(isReplyHookCommand("/opt/agent-voice-wrapper.sh reply --agent codex", "codex")).toBe(false);
    expect(isReplyHookCommand("'/usr/bin/node' '/opt/other-tool/index.js' reply --agent codex", "codex")).toBe(false);
  });
});

describe("addReplyHook and removeReplyHook", () => {
  it("appends one Stop entry, keeps every other byte, and restores the file exactly", () => {
    const withHook = added(claudeSettings);
    const stopArrayEnd = claudeSettings.indexOf("    ]");
    const textBeforeStopEnd = claudeSettings.slice(0, stopArrayEnd).trimEnd();

    expect(withHook.changed).toBe(true);
    expect(stopCommands(withHook.source)).toEqual(["notify-send done", command]);
    expect(withHook.source.startsWith(textBeforeStopEnd)).toBe(true);
    expect(withHook.source).toContain("// my settings");
    expect(removed(withHook.source)).toEqual({ source: claudeSettings, changed: true });
  });

  it("creates hooks.Stop in a file without hooks and removes it again byte for byte", () => {
    const plain = '{\n    "model": "opus"\n}\n';
    const withHook = added(plain);

    expect(parse(withHook.source)).toEqual({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command }] }] },
    });
    expect(withHook.source).toContain('\n    "hooks": {\n        "Stop": [');
    expect(removed(withHook.source).source).toBe(plain);
  });

  it("adds Stop beside other hook events and removes only what it added", () => {
    const codexHooks =
      '{\n  "hooks": {\n    "PreToolUse": [{"hooks":[{"type":"command","command":"guard"}]}]\n  }\n}\n';
    const withHook = added(codexHooks);

    expect(Object.keys(parse(withHook.source).hooks)).toEqual(["PreToolUse", "Stop"]);
    expect(removed(withHook.source).source).toBe(codexHooks);
  });

  it("writes a fresh file when there is none, and leaves an empty object behind on removal", () => {
    const fresh = added("");

    expect(stopCommands(fresh.source)).toEqual([command]);
    expect(isEmptySettings(removed(fresh.source).source)).toBe(true);
  });

  it("does nothing when the same command is already there, and replaces an entry from an older agent-voice path", () => {
    const once = added(claudeSettings).source;
    expect(added(once)).toEqual({ source: once, changed: false });

    const moved = command.replace("/Users/me/Code/agent-voice", "/opt/agent-voice");
    const updated = added(once, moved);
    expect(updated.changed).toBe(true);
    expect(stopCommands(updated.source)).toEqual(["notify-send done", moved]);
  });

  it("removes only agent-voice's hook when the user moved it into a group with other hooks", () => {
    const shared = `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify"},{"type":"command","command":${JSON.stringify(command)}}]}]}}`;
    const withoutAgentVoice = removed(shared);

    expect(withoutAgentVoice.changed).toBe(true);
    expect(parse(withoutAgentVoice.source)).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
    });
  });

  it("keeps another tool's Stop hook that mentions agent-voice when removing", () => {
    const foreign =
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say agent-voice reply --agent codex"}]}]}}';

    expect(removed(foreign)).toEqual({ source: foreign, changed: false });
    expect(stopCommands(added(foreign).source)).toEqual(["say agent-voice reply --agent codex", command]);
  });

  it("treats a file as empty only when nothing but {} and whitespace is left, so a comment keeps it", () => {
    expect(isEmptySettings("{\n}\n")).toBe(true);
    expect(isEmptySettings("{\n  // my note\n}\n")).toBe(false);
    expect(isEmptySettings('{"model": "opus"}')).toBe(false);
  });

  it("leaves a file without agent-voice's entry unchanged and refuses a file that is not a JSON object", () => {
    const arraySettings = addReplyHook({ source: "[1, 2]", command, agent: "codex" });
    const objectStop = addReplyHook({ source: '{"hooks": {"Stop": {}}}', command, agent: "codex" });

    expect(removed(claudeSettings)).toEqual({ source: claudeSettings, changed: false });
    expect(Either.isLeft(arraySettings)).toBe(true);
    expect(Either.isLeft(objectStop)).toBe(true);
  });
});
