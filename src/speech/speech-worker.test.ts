import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder, makeTestSocketPath } from "#src/testing/test-folder.js";
import { queueReply } from "./inbox.js";
import { makeSpeechPlayer } from "./speech-player.js";
import { speakNextReply } from "./speech-worker.js";
import type { SupertonicEngine } from "./supertonic.js";

let home = "";
let server: Server | undefined;

beforeEach(() => {
  home = makeTestFolder("speech-worker");
  vi.stubEnv("AGENT_VOICE_HOME", home);
  const settingsFile = path.join(home, "config.json");
  const settingsFileMessages = JSON.stringify({ speechMode: "auto", speechMuted: false });
  writeFileSync(settingsFile, settingsFileMessages);
});

afterEach(async () => {
  await new Promise((finish) => {
    const isServerMissing = server == null;
    if (isServerMissing) {
      finish(undefined);
      return;
    }

    server.close(finish);
  });
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const engine: SupertonicEngine = { sampleRate: 44_100, synthesize: async () => new Float32Array(441) };

const createSilentPlayer = () => ({ ...makeSpeechPlayer(), play: vi.fn(async () => undefined) });

describe("speakNextReply", () => {
  it("plays a queued reply", async () => {
    const player = createSilentPlayer();
    queueReply({ markdown: "Done.", source: "claude-code", agentReplyId: "r1", origin: { kind: "terminal" } });

    await speakNextReply(engine, player);

    expect(player.play).toHaveBeenCalledOnce();
  });

  it("keeps a reply silent when a stop comes in while it is being claimed", async () => {
    const player = createSilentPlayer();
    const socketPath = makeTestSocketPath(home);
    // The stop lands during the Cmux focus check; with no reply line the focus is unknown, so the reply is claimed.
    server = createServer((connection) => {
      player.stop();
      connection.resume().end();
    });
    await new Promise((finish) => server?.listen(socketPath, () => finish(undefined)));
    queueReply({
      markdown: "Done.",
      source: "claude-code",
      agentReplyId: "r1",
      origin: { kind: "cmux", socketPath, workspaceId: "W1", surfaceId: "S1" },
    });

    const step = await speakNextReply(engine, player);

    expect(step).toBe("spoke");
    expect(player.play).not.toHaveBeenCalled();
  });
});
