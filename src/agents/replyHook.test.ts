import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestFolder, repositoryRoot } from "../scripts/testFolder.js";

const mainScript = path.join(repositoryRoot, "src", "cli", "main.ts");

let home = "";
let sleepers: ReadonlyArray<ChildProcess> = [];

// Pid files naming sleeping processes whose command lines end in `worker dictation` and `worker speech` make
// voxkey believe both workers already run, so no real worker starts. The test kills only these sleepers.
beforeEach(async () => {
  home = makeTestFolder("reply");
  const spawned = (["dictation", "speech"] as const).map((kind) => {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "worker", kind], {
      stdio: "ignore",
    });
    const pidPath = path.join(home, `${kind}.pid`);
    writeFileSync(pidPath, `${sleeper.pid}`);
    return { sleeper, ready: new Promise((resolve) => sleeper.once("spawn", resolve)) };
  });
  sleepers = spawned.map((entry) => entry.sleeper);
  for (const entry of spawned) {
    await entry.ready;
  }
});

afterEach(() => {
  for (const sleeper of sleepers) {
    sleeper.kill("SIGKILL");
  }
  rmSync(home, { recursive: true, force: true });
});

const writeConfig = (configText: string): void => {
  const configPath = path.join(home, "config.json");
  writeFileSync(configPath, configText);
};

const runHook = (request: {
  readonly agent: string;
  readonly stdin: string;
  readonly speechMode?: "auto" | "off";
  readonly speechMuted?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
}) => {
  const configText = JSON.stringify({
    speechMode: request.speechMode || "auto",
    speechMuted: request.speechMuted === true,
  });
  writeConfig(configText);
  return spawnSync(process.execPath, ["--import", "tsx", mainScript, "reply", "--agent", request.agent], {
    cwd: repositoryRoot,
    input: request.stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      VOXKEY_HOME: home,
      CMUX_WORKSPACE_ID: "",
      CMUX_SURFACE_ID: "",
      CMUX_SOCKET_PATH: "",
      ...request.environment,
    },
  });
};

const queued = (): ReadonlyArray<unknown> => {
  const inbox = path.join(home, "inbox");
  if (!existsSync(inbox)) {
    return [];
  }

  return readdirSync(inbox).map((name) => {
    const replyPath = path.join(inbox, name);
    const replyText = readFileSync(replyPath, "utf8");
    return JSON.parse(replyText);
  });
};

describe("voxkey reply (the agent Stop hook)", () => {
  it("queues Claude's complete reply without rewriting the Markdown, silently", () => {
    const markdown = "# Release\n\n| Item | State |\n| --- | --- |\n| Voice | Ready |\n\n```ts\nconst count = 2;\n```";
    const execution = runHook({ agent: "claude-code", stdin: JSON.stringify({ last_assistant_message: markdown }) });

    expect(execution.status).toBe(0);
    expect(execution.stdout).toBe("");
    expect(execution.stderr).toBe("");
    expect(queued()).toEqual([
      expect.objectContaining({ markdown, origin: { kind: "terminal" }, source: "claude-code" }),
    ]);
  });

  it("queues nothing when speech is off", () => {
    const execution = runHook({
      agent: "codex",
      stdin: JSON.stringify({ last_assistant_message: "Stay silent" }),
      speechMode: "off",
    });

    expect(execution.status).toBe(0);
    expect(queued()).toEqual([]);
  });

  it("queues nothing while speech is muted, so unmuting reads no backlog", () => {
    const execution = runHook({
      agent: "claude-code",
      stdin: JSON.stringify({ last_assistant_message: "Missed while muted" }),
      speechMuted: true,
    });

    expect(execution.status).toBe(0);
    expect(execution.stdout).toBe("");
    expect(queued()).toEqual([]);
  });

  it("binds a Cmux reply to its surface and never stores the socket capability", () => {
    const execution = runHook({
      agent: "codex",
      stdin: JSON.stringify({ last_assistant_message: "Focused reply" }),
      environment: {
        CMUX_SOCKET_CAPABILITY: "must-not-leak",
        CMUX_SOCKET_PATH: "/run/cmux-test.sock",
        CMUX_SURFACE_ID: "surface-uuid",
        CMUX_WORKSPACE_ID: "workspace-uuid",
      },
    });

    expect(execution.status).toBe(0);
    expect(queued()).toEqual([
      expect.objectContaining({
        origin: {
          kind: "cmux",
          socketPath: "/run/cmux-test.sock",
          workspaceId: "workspace-uuid",
          surfaceId: "surface-uuid",
        },
      }),
    ]);
    const queuedReplies = queued();
    const queuedText = JSON.stringify(queuedReplies);
    expect(queuedText).not.toContain("must-not-leak");
  });

  it("queues a finished Grok turn and ignores a session close", () => {
    const grokStop = (reason: string, lastAssistantMessage: string) =>
      JSON.stringify({ hookEventName: "Stop", reason, lastAssistantMessage });

    runHook({ agent: "grok", stdin: grokStop("shutdown", "Closing") });
    expect(queued()).toEqual([]);

    runHook({ agent: "grok", stdin: grokStop("end_turn", "Complete answer") });
    expect(queued()).toEqual([expect.objectContaining({ markdown: "Complete answer", source: "grok" })]);
  });

  it("falls back to the transcript after the latest genuine user prompt", () => {
    const transcript = fileURLToPath(new URL("./fixtures/claudeTranscript.jsonl", import.meta.url));
    runHook({ agent: "codex", stdin: JSON.stringify({ transcript_path: transcript }) });

    expect(queued()).toEqual([expect.objectContaining({ markdown: "First section\n\nSecond section\n\n- complete" })]);
  });

  it("exits 0 with no output and queues nothing when --agent is unknown, missing, empty, or has extra arguments", () => {
    const configText = JSON.stringify({ speechMode: "auto", speechMuted: false });
    writeConfig(configText);
    const stdin = JSON.stringify({ last_assistant_message: "Should not be queued" });
    for (const args of [
      ["--agent", "nosuch"],
      [],
      ["--agent"],
      ["--agent="],
      ["--bogus", "--agent", "renamed-agent"],
    ]) {
      const execution = spawnSync(process.execPath, ["--import", "tsx", mainScript, "reply", ...args], {
        cwd: repositoryRoot,
        input: stdin,
        encoding: "utf8",
        env: { ...process.env, VOXKEY_HOME: home },
      });
      expect([args.join(" "), execution.status, execution.stdout, execution.stderr]).toEqual([
        args.join(" "),
        0,
        "",
        "",
      ]);
    }
    expect(queued()).toEqual([]);

    const extra = spawnSync(
      process.execPath,
      ["--import", "tsx", mainScript, "reply", "--agent=codex", "--later-flag"],
      {
        cwd: repositoryRoot,
        input: stdin,
        encoding: "utf8",
        env: { ...process.env, VOXKEY_HOME: home },
      },
    );
    expect([extra.status, extra.stdout, extra.stderr]).toEqual([0, "", ""]);
    expect(queued()).toHaveLength(1);
  });

  it("exits 0 with no output for garbage input, a missing transcript, or a broken config", () => {
    for (const stdin of ["not json", "[]", JSON.stringify({ transcript_path: path.join(home, "missing.jsonl") })]) {
      const execution = runHook({ agent: "claude-code", stdin });
      expect([execution.status, execution.stdout, execution.stderr]).toEqual([0, "", ""]);
    }
    writeConfig("{ broken");
    const broken = spawnSync(process.execPath, ["--import", "tsx", mainScript, "reply", "--agent", "codex"], {
      cwd: repositoryRoot,
      input: JSON.stringify({ last_assistant_message: "dropped, because the defaults are muted" }),
      encoding: "utf8",
      env: { ...process.env, VOXKEY_HOME: home },
    });
    expect([broken.status, broken.stdout, broken.stderr]).toEqual([0, "", ""]);
    expect(queued()).toEqual([]);
  });
});
