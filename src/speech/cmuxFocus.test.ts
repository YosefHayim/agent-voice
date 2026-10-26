import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestFolder, makeTestSocketPath } from "../scripts/testFolder.js";
import { cmuxFocus } from "./cmuxFocus.js";

let folder = "";
let server: Server | undefined;

beforeEach(() => {
  folder = makeTestFolder("cmux");
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
  rmSync(folder, { recursive: true, force: true });
});

describe("cmuxFocus", () => {
  it("is unknown, not stuck, when Cmux closes the connection without a reply line", async () => {
    const socketPath = makeTestSocketPath(folder);
    // Read the client's side too, so the server sees it close; the reply side ends with no line at all.
    server = createServer((connection) => connection.resume().end());
    await new Promise((resolve) => server?.listen(socketPath, () => resolve(undefined)));

    const askFocus = cmuxFocus(socketPath).pipe(Effect.timeout("2 seconds"));
    const focus = await Effect.runPromise(askFocus);

    expect(focus).toEqual({ kind: "unknown" });
  });
});
