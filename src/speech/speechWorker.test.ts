import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queueReply } from "./inbox.js";
import { makeSpeechPlayer } from "./speechPlayer.js";
import { speakNextReply } from "./speechWorker.js";
import type { SupertonicEngine } from "./supertonic.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";
let server: Server | undefined;

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "worker-"));
  vi.stubEnv("VOXKEY_HOME", home);
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ speechMode: "auto", speechMuted: false }));
});

afterEach(async () => {
  await new Promise((resolve) => (server === undefined ? resolve(undefined) : server.close(resolve)));
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const engine: SupertonicEngine = { sampleRate: 44_100, synthesize: () => Effect.succeed(new Float32Array(441)) };

const silentPlayer = () => ({ ...makeSpeechPlayer(), play: vi.fn(() => Effect.void) });

describe("speakNextReply", () => {
  it("plays a queued reply", async () => {
    const player = silentPlayer();
    queueReply({ markdown: "Done.", source: "claude-code", agentReplyId: "r1", origin: { kind: "terminal" } });

    await Effect.runPromise(speakNextReply(engine, player));

    expect(player.play).toHaveBeenCalledOnce();
  });

  it("keeps a reply silent when a stop comes in while it is being claimed", async () => {
    const player = silentPlayer();
    const socketPath = path.join(home, "c.sock");
    // The stop lands during the Cmux focus check; with no reply line the focus is unknown, so the reply is claimed.
    server = createServer((connection) => {
      player.stop();
      connection.resume().end();
    });
    await new Promise((resolve) => server?.listen(socketPath, () => resolve(undefined)));
    queueReply({
      markdown: "Done.",
      source: "claude-code",
      agentReplyId: "r1",
      origin: { kind: "cmux", socketPath, workspaceId: "W1", surfaceId: "S1" },
    });

    const step = await Effect.runPromise(speakNextReply(engine, player));

    expect(step).toBe("spoke");
    expect(player.play).not.toHaveBeenCalled();
  });
});
