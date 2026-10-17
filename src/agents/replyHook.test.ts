import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentVoice } from "../scripts/runAgentVoice.js";
import { makeTestFolder, repositoryRoot } from "../scripts/testFolder.js";

let home = "";
let sleepers: ReadonlyArray<ChildProcess> = [];

// Pid files naming sleeping processes whose command lines end in `worker dictation` and `worker speech` make
// agent-voice believe both workers already run, so no real worker starts. The test kills only these sleepers.
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
  return runAgentVoice({
    args: ["reply", "--agent", request.agent],
    stdin: request.stdin,
    environment: {
      ...process.env,
      AGENT_VOICE_HOME: home,
      CMUX_WORKSPACE_ID: "",
      CMUX_SURFACE_ID: "",
      CMUX_SOCKET_PATH: "",
      ...request.environment,
    },
  });
};

const removePidFile = (kind: "dictation" | "speech"): void => {
  const pidPath = path.join(home, `${kind}.pid`);
  rmSync(pidPath);
};

// The test holds the dictation lock (O_EXLOCK, 0x20 on macOS), so the worker the hook starts finds it taken and exits
// without loading a model.
const holdDictationLock = (): number => {
  const lockPath = path.join(home, "dictation.lock");
  return openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | 0x20, 0o600);
};

const mainScript = path.join(repositoryRoot, "src", "cli", "main.ts");

const isTestWorkerRunning = (): boolean => {
  const processList = spawnSync("ps", ["-ax", "-o", "args="], { encoding: "utf8" });
  return processList.stdout.includes(`${mainScript} worker dictation`);
};

const testWorkerExited = async (): Promise<boolean> => {
  const deadline = Date.now() + 10_000;
  while (isTestWorkerRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isTestWorkerRunning();
};

const runReply = (args: ReadonlyArray<string>, stdin: string) =>
  runAgentVoice({ args: ["reply", ...args], stdin, environment: { ...process.env, AGENT_VOICE_HOME: home } });

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

describe("agent-voice reply (the agent Stop hook)", () => {
  it("queues Claude's complete reply without rewriting the Markdown, silently", async () => {
    const markdown = "# Release\n\n| Item | State |\n| --- | --- |\n| Voice | Ready |\n\n```ts\nconst count = 2;\n```";
    const execution = await runHook({
      agent: "claude-code",
      stdin: JSON.stringify({ last_assistant_message: markdown }),
    });

    expect(execution.status).toBe(0);
    expect(execution.stdout).toBe("");
    expect(execution.stderr).toBe("");
    expect(queued()).toEqual([
      expect.objectContaining({ markdown, origin: { kind: "terminal" }, source: "claude-code" }),
    ]);
  });

  it("queues nothing and starts no speech worker when speech is off", async () => {
    removePidFile("speech");
    const execution = await runHook({
      agent: "codex",
      stdin: JSON.stringify({ last_assistant_message: "Stay silent" }),
      speechMode: "off",
    });

    expect(execution.status).toBe(0);
    expect(queued()).toEqual([]);
    const speechLog = path.join(home, "speech-worker.log");
    expect(existsSync(speechLog)).toBe(false);
  });

  it("starts the dictation worker after a reboot even when speech is off", async () => {
    removePidFile("dictation");
    const lock = holdDictationLock();
    try {
      const execution = await runHook({
        agent: "claude-code",
        stdin: JSON.stringify({ last_assistant_message: "Stay silent" }),
        speechMode: "off",
      });

      expect(execution.status).toBe(0);
      const dictationLog = path.join(home, "dictation-worker.log");
      expect(existsSync(dictationLog)).toBe(true);
      expect(await testWorkerExited()).toBe(true);
    } finally {
      closeSync(lock);
    }
  });

  it("queues nothing while speech is muted, so unmuting reads no backlog", async () => {
    const execution = await runHook({
      agent: "claude-code",
      stdin: JSON.stringify({ last_assistant_message: "Missed while muted" }),
      speechMuted: true,
    });

    expect(execution.status).toBe(0);
    expect(execution.stdout).toBe("");
    expect(queued()).toEqual([]);
  });

  it("binds a Cmux reply to its surface and never stores the socket capability", async () => {
    const execution = await runHook({
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

  it("queues a finished Grok turn and ignores a session close", async () => {
    const grokStop = (reason: string, lastAssistantMessage: string) =>
      JSON.stringify({ hookEventName: "Stop", reason, lastAssistantMessage });

    await runHook({ agent: "grok", stdin: grokStop("shutdown", "Closing") });
    expect(queued()).toEqual([]);

    await runHook({ agent: "grok", stdin: grokStop("end_turn", "Complete answer") });
    expect(queued()).toEqual([expect.objectContaining({ markdown: "Complete answer", source: "grok" })]);
  });

  it("falls back to the transcript after the latest genuine user prompt", async () => {
    const transcript = fileURLToPath(new URL("./fixtures/claudeTranscript.jsonl", import.meta.url));
    await runHook({ agent: "codex", stdin: JSON.stringify({ transcript_path: transcript }) });

    expect(queued()).toEqual([expect.objectContaining({ markdown: "First section\n\nSecond section\n\n- complete" })]);
  });

  it("exits 0 with no output and queues nothing when --agent is unknown, missing, empty, or has extra arguments", async () => {
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
      const execution = await runReply(args, stdin);
      expect([args.join(" "), execution.status, execution.stdout, execution.stderr]).toEqual([
        args.join(" "),
        0,
        "",
        "",
      ]);
    }
    expect(queued()).toEqual([]);

    const extra = await runReply(["--agent=codex", "--later-flag"], stdin);
    expect([extra.status, extra.stdout, extra.stderr]).toEqual([0, "", ""]);
    expect(queued()).toHaveLength(1);
  });

  it("exits 0 with no output for garbage input, a missing transcript, or a broken config", async () => {
    for (const stdin of ["not json", "[]", JSON.stringify({ transcript_path: path.join(home, "missing.jsonl") })]) {
      const execution = await runHook({ agent: "claude-code", stdin });
      expect([execution.status, execution.stdout, execution.stderr]).toEqual([0, "", ""]);
    }
    writeConfig("{ broken");
    const droppedReply = JSON.stringify({ last_assistant_message: "dropped, because the defaults are muted" });
    const broken = await runReply(["--agent", "codex"], droppedReply);
    expect([broken.status, broken.stdout, broken.stderr]).toEqual([0, "", ""]);
    expect(queued()).toEqual([]);
  });
});
