import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmuxFocus } from "./cmuxFocus.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let folder = "";
let server: Server | undefined;

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  folder = mkdtempSync(path.join(scratchRoot, "cmux-"));
});

afterEach(async () => {
  await new Promise((resolve) => (server === undefined ? resolve(undefined) : server.close(resolve)));
  server = undefined;
  rmSync(folder, { recursive: true, force: true });
});

describe("cmuxFocus", () => {
  it("is unknown, not stuck, when Cmux closes the connection without a reply line", async () => {
    const socketPath = path.join(folder, "c.sock");
    // Read the client's side too, so the server sees it close; the reply side ends with no line at all.
    server = createServer((connection) => connection.resume().end());
    await new Promise((resolve) => server?.listen(socketPath, () => resolve(undefined)));

    const focus = await Effect.runPromise(Effect.timeout(cmuxFocus(socketPath), "2 seconds"));

    expect(focus).toEqual({ kind: "unknown" });
  });
});
