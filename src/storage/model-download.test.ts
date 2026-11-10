import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMacOS, makeTestFolder, repositoryRoot } from "#src/testing/test-folder.js";
import { downloadFile } from "./model-download.js";

const modelDownloadUrl = new URL("./model-download.js", import.meta.url);
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

// The test server listens on a TCP port, so its address is an object that carries the port.
const readPort = (address: AddressInfo | string | null): number => {
  const isNotTcpAddress = address == null || typeof address !== "object";
  if (isNotTcpAddress) {
    throw new Error("the test server is not on a TCP port");
  }

  return address.port;
};

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
  await new Promise((fulfill) => server?.listen(0, "127.0.0.1", () => fulfill(undefined)));
  const address = server.address();
  const port = readPort(address);
  origin = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((fulfill) => server?.close(fulfill));
  chmodSync(folder, 0o700);
  rmSync(folder, { recursive: true, force: true });
});

// Another process downloading the same file with the same code, as a second `agent-voice on` or worker would.
const startDownloader = (request: { readonly url: string; readonly destination: string }) => {
  // Same source condition as run-agent-voice.ts: without it, "#src/*" resolves to dist/, which may not be built.
  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
const [modulePath, url, destination] = process.argv.slice(1);
const { downloadFile } = await import(modulePath);
await downloadFile({ url, destination, onProgress: () => undefined });
`,
      modelDownloadModule,
      request.url,
      request.destination,
    ],
    { cwd: repositoryRoot, stdio: "ignore" },
  );
  return { child, exited: new Promise<number | null>((fulfill) => child.once("exit", fulfill)) };
};

const waitUntilTrue = async (check: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + 20_000;
  while (!check() && Date.now() < deadline) {
    await new Promise((fulfill) => setTimeout(fulfill, 20));
  }
  return check();
};

// A download that waits on a lock nobody will release fails the test instead of hanging it.
const download = async (request: { readonly url: string; readonly destination: string }): Promise<void> => {
  const downloadAttempt = downloadFile({ ...request, onProgress: () => undefined });
  const blockedAfterMilliseconds = 10_000;
  const blockedAttempt = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("the download is still blocked")), blockedAfterMilliseconds);
    timer.unref();
  });

  await Promise.race([downloadAttempt, blockedAttempt]);
};

describe("downloadFile", () => {
  it("writes the file through a .partial file and reports the bytes received", async () => {
    const destination = path.join(folder, "model.bin");
    const progress: Array<number> = [];

    await downloadFile({
      url: `${origin}/model.bin`,
      destination,
      onProgress: (bytes) => progress.push(bytes),
    });

    expect(readFileSync(destination).length).toBe(MODEL_BYTES);
    expect(progress.at(-1)).toBe(MODEL_BYTES);
    expect(existsSync(`${destination}.partial`)).toBe(false);
    expect(existsSync(`${destination}.lock`)).toBe(false);
  });

  it("fails with a download error, instead of crashing, when the file cannot be written", async () => {
    chmodSync(folder, 0o500);

    const downloadAttempt = downloadFile({
      url: `${origin}/model.bin`,
      destination: path.join(folder, "model.bin"),
      onProgress: () => undefined,
    });

    await expect(downloadAttempt).rejects.toThrow("EACCES");
  });

  it("fails with a download error, instead of crashing, when the progress callback throws mid-download or at the end", async () => {
    for (const name of ["large.bin", "model.bin"]) {
      const destination = path.join(folder, name);
      const downloadAttempt = downloadFile({
        url: `${origin}/${name}`,
        destination,
        onProgress: () => {
          throw new Error("the progress line broke");
        },
      });

      await expect(downloadAttempt).rejects.toThrow("the progress line broke");
      expect([name, existsSync(destination), existsSync(`${destination}.partial`)]).toEqual([name, false, false]);
    }
  });

  it.skipIf(!isMacOS)(
    "waits for another process downloading the same file, then reuses its file instead of downloading again",
    async () => {
      const destination = path.join(folder, "model.bin");
      const other = startDownloader({ url: `${origin}/slow.bin`, destination });
      const isFirstRequestSeen = await waitUntilTrue(() => requests.length === 1);
      expect(isFirstRequestSeen).toBe(true);

      await download({ url: `${origin}/slow.bin`, destination });

      const otherExitCode = await other.exited;
      expect(otherExitCode).toBe(0);
      expect(requests).toEqual(["/slow.bin"]);
      expect(readFileSync(destination)).toEqual(Buffer.concat([half, half]));
      expect(existsSync(`${destination}.partial`)).toBe(false);
      expect(existsSync(`${destination}.lock`)).toBe(false);
    },
  );

  it("is not blocked by a download that crashed, and replaces the half file it left", async () => {
    const destination = path.join(folder, "model.bin");
    const crashed = startDownloader({ url: `${origin}/stall.bin`, destination });
    const partial = `${destination}.partial`;
    const isPartialWritten = await waitUntilTrue(() => existsSync(partial) && statSync(partial).size > 0);
    expect(isPartialWritten).toBe(true);
    crashed.child.kill("SIGKILL");
    await crashed.exited;
    expect(existsSync(`${destination}.lock`)).toBe(true);

    await download({ url: `${origin}/model.bin`, destination });

    expect(readFileSync(destination)).toEqual(Buffer.concat([half, half]));
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(`${destination}.lock`)).toBe(false);
  });
});
