import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { queueReply } from "./inbox.js";
import { makeSpeechPlayer } from "./speechPlayer.js";
import { speakNextReply } from "./speechWorker.js";
import type { SupertonicEngine } from "./supertonic.js";

let home = "";
let server: Server | undefined;

beforeEach(() => {
  home = makeTestFolder("speech-worker");
  vi.stubEnv("VOXKEY_HOME", home);
  const configFile = path.join(home, "config.json");
  const config = JSON.stringify({ speechMode: "auto", speechMuted: false });
  writeFileSync(configFile, config);
});

afterEach(async () => {
  await new Promise((resolve) => {
    if (server === undefined) {
      resolve(undefined);
      return;
    }

    server.close(resolve);
  });
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

    const speaking = speakNextReply(engine, player);
    await Effect.runPromise(speaking);

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

    const speaking = speakNextReply(engine, player);
    const step = await Effect.runPromise(speaking);

    expect(step).toBe("spoke");
    expect(player.play).not.toHaveBeenCalled();
  });
});
