import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestFolder, makeTestSocketPath } from "#src/testing/test-folder.js";
import { cmuxFocus } from "./cmux-focus.js";

let folder = "";
let server: Server | undefined;

beforeEach(() => {
  folder = makeTestFolder("cmux");
});

afterEach(async () => {
  const runningServer = server;
  server = undefined;
  if (runningServer !== undefined) {
    await new Promise<void>((closed) => runningServer.close(() => closed()));
  }

  rmSync(folder, { recursive: true, force: true });
});

describe("cmuxFocus", () => {
  // Cmux answers in well under a second; a longer wait means the call hung.
  const answerTimeoutMilliseconds = 2_000;

  it(
    "is unknown, not stuck, when Cmux closes the connection without a reply line",
    async () => {
      const socketPath = makeTestSocketPath(folder);
      // Read the client's side too, so the server sees it close; the reply side ends with no line at all.
      const silentServer = createServer((connection) => connection.resume().end());
      server = silentServer;
      await new Promise<void>((listening) => silentServer.listen(socketPath, () => listening()));

      const focus = await cmuxFocus(socketPath);

      expect(focus).toEqual({ kind: "unknown" });
    },
    answerTimeoutMilliseconds,
  );
});
