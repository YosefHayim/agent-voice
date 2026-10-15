import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Duration, Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestFolder, repositoryRoot } from "../scripts/testFolder.js";
import { downloadFile } from "./modelDownload.js";

const modelDownloadUrl = new URL("./modelDownload.js", import.meta.url);
const modelDownloadModule = fileURLToPath(modelDownloadUrl);

let folder = "";
let server: Server | undefined;
let origin = "";
let requests: Array<string> = [];

const MODEL_BYTES = 1_024;

// Past the 20 MB progress step, so a progress report lands while bytes are still arriving.
const LARGE_BYTES = 21_000_000;

const half = Buffer.alloc(MODEL_BYTES / 2, 7);

const largeModel = Buffer.alloc(LARGE_BYTES, 7);

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));

const sendInHalves = (served: ServerResponse, delayMs: number): void => {
  served.write(half);
  setTimeout(() => served.end(half), delayMs);
};

// A local server stands in for Hugging Face; nothing leaves the Mac. The second half of a model arrives later, so a
// file error lands while the download waits for more bytes (a small first chunk is buffered without waiting for
// "drain"). /slow.bin takes 1.5 s, /stall.bin never finishes, and /large.bin is past the progress step.
beforeEach(async () => {
  folder = makeTestFolder("download");
  requests = [];
  server = createServer((request, served) => {
    requests.push(request.url || "");
    switch (request.url) {
      case "/large.bin":
        served.end(largeModel);
        return;
      case "/stall.bin":
        served.write(half);
        return;
      case "/slow.bin":
        sendInHalves(served, 1_500);
        return;
      default:
        sendInHalves(served, 200);
    }
  });
  await new Promise((resolve) => server?.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const { port } = decodeAddress(address);
  origin = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  chmodSync(folder, 0o700);
  rmSync(folder, { recursive: true, force: true });
});

const DOWNLOADER = `
const [modulePath, url, destination] = process.argv.slice(1);
const { Effect } = await import("effect");
const { downloadFile } = await import(modulePath);
await downloadFile({ url, destination, onProgress: () => undefined }).pipe(Effect.runPromise);
`;

// Another process downloading the same file with the same code, as a second `voxkey on` or worker would.
const startDownloader = (request: { readonly url: string; readonly destination: string }) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", DOWNLOADER, modelDownloadModule, request.url, request.destination],
    { cwd: repositoryRoot, stdio: "ignore" },
  );
  return { child, exited: new Promise<number | null>((resolve) => child.once("exit", resolve)) };
};

const eventually = async (check: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + 20_000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

// A download that waits on a lock nobody will release fails the test instead of hanging it.
const download = (request: { readonly url: string; readonly destination: string }) =>
  downloadFile({ ...request, onProgress: () => undefined }).pipe(
    Effect.timeoutFail({
      duration: Duration.seconds(10),
      onTimeout: () => new Error("the download is still blocked"),
    }),
    Effect.runPromise,
  );

describe("downloadFile", () => {
  it("writes the file through a .partial file and reports the bytes received", async () => {
    const destination = path.join(folder, "model.bin");
    const progress: Array<number> = [];

    await downloadFile({
      url: `${origin}/model.bin`,
      destination,
      onProgress: (bytes) => progress.push(bytes),
    }).pipe(Effect.runPromise);

    expect(readFileSync(destination).length).toBe(MODEL_BYTES);
    expect(progress.at(-1)).toBe(MODEL_BYTES);
    expect(existsSync(`${destination}.partial`)).toBe(false);
    expect(existsSync(`${destination}.lock`)).toBe(false);
  });

  it("fails with a download error, instead of crashing, when the file cannot be written", async () => {
    chmodSync(folder, 0o500);

    const failure = await downloadFile({
      url: `${origin}/model.bin`,
      destination: path.join(folder, "model.bin"),
      onProgress: () => undefined,
    }).pipe(Effect.flip, Effect.runPromise);

    expect(failure._tag).toBe("ModelDownloadError");
    expect(failure.issue).toContain("EACCES");
  });

  it("fails with a download error, instead of crashing, when the progress callback throws mid-download or at the end", async () => {
    for (const name of ["large.bin", "model.bin"]) {
      const destination = path.join(folder, name);
      const failure = await downloadFile({
        url: `${origin}/${name}`,
        destination,
        onProgress: () => {
          throw new Error("the progress line broke");
        },
      }).pipe(Effect.flip, Effect.runPromise);

      expect(failure.issue).toBe("the progress line broke");
      expect([name, existsSync(destination), existsSync(`${destination}.partial`)]).toEqual([name, false, false]);
    }
  });

  it("waits for another process downloading the same file, then reuses its file instead of downloading again", async () => {
    const destination = path.join(folder, "model.bin");
    const other = startDownloader({ url: `${origin}/slow.bin`, destination });
    expect(await eventually(() => requests.length === 1)).toBe(true);

    await download({ url: `${origin}/slow.bin`, destination });

    expect(await other.exited).toBe(0);
    expect(requests).toEqual(["/slow.bin"]);
    expect(readFileSync(destination)).toEqual(Buffer.concat([half, half]));
    expect(existsSync(`${destination}.partial`)).toBe(false);
    expect(existsSync(`${destination}.lock`)).toBe(false);
  });

  it("is not blocked by a download that crashed, and replaces the half file it left", async () => {
    const destination = path.join(folder, "model.bin");
    const crashed = startDownloader({ url: `${origin}/stall.bin`, destination });
    const partial = `${destination}.partial`;
    expect(await eventually(() => existsSync(partial) && statSync(partial).size > 0)).toBe(true);
    crashed.child.kill("SIGKILL");
    await crashed.exited;
    expect(existsSync(`${destination}.lock`)).toBe(true);

    await download({ url: `${origin}/model.bin`, destination });

    expect(readFileSync(destination)).toEqual(Buffer.concat([half, half]));
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(`${destination}.lock`)).toBe(false);
  });
});
