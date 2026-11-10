import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMacOS, makeTestFolder, repositoryRoot } from "#src/testing/test-folder.js";
import { isWorkerRunning, stopWorkers } from "./worker-processes.js";

const workerProcessesModule = fileURLToPath(new URL("./worker-processes.js", import.meta.url));

let home = "";
const started: Array<ChildProcess> = [];

beforeEach(() => {
  home = makeTestFolder("workers");
  vi.stubEnv("AGENT_VOICE_HOME", home);
});

// Only processes this test started are ever signalled, here or by agent-voice.
afterEach(() => {
  for (const child of started.splice(0)) {
    child.kill("SIGKILL");
  }
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const readHomeFile = (name: string): string => path.join(home, name);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A sleeping Node process whose command line ends with `trailing`, such as ["worker", "dictation"].
const startSleeper = async (trailing: ReadonlyArray<string>): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", ...trailing], {
    stdio: "ignore",
    detached: true,
  });
  started.push(child);
  await new Promise((resolve) => child.once("spawn", resolve));
  return child.pid || 0;
};

const writePidFile = (name: string, pid: number) => {
  const pidPath = readHomeFile(name);
  writeFileSync(pidPath, `${pid}`);
};

const waitUntilTrue = async (check: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

describe("worker pid files", () => {
  it("trust a pid only while it still runs that worker's command line (a pid reused after a reboot is not a worker)", async () => {
    writePidFile("dictation.pid", process.pid);
    expect(isWorkerRunning("dictation")).toBe(false);

    const worker = await startSleeper(["worker", "dictation"]);
    writePidFile("dictation.pid", worker);
    writePidFile("speech.pid", worker);
    expect(await waitUntilTrue(() => isWorkerRunning("dictation"))).toBe(true);
    expect(isWorkerRunning("speech")).toBe(false);
  });

  it("stopWorkers never signals a process its pid file does not name, and stops one it does", async () => {
    const stranger = await startSleeper([]);
    for (const name of ["dictation.pid", "pill.pid"]) {
      writePidFile(name, stranger);
    }
    const speech = await startSleeper(["worker", "speech"]);
    writePidFile("speech.pid", speech);
    expect(await waitUntilTrue(() => isWorkerRunning("speech"))).toBe(true);

    await stopWorkers();

    const dictationPidFile = readHomeFile("dictation.pid");
    expect(await waitUntilTrue(() => !isAlive(speech))).toBe(true);
    expect(isAlive(stranger)).toBe(true);
    expect(existsSync(dictationPidFile)).toBe(false);
  });
});

// A starter: once the `go` file exists it claims the dictation lock, prints "owner" or "busy", and an owner keeps the
// lock for holdMs, so every racer tries while the winner still holds it. Its command line ends like a real dictation
// worker's, so `ps` takes each starter for one.
const STARTER = `
const [modulePath, go, holdMs] = process.argv.slice(1);
const { existsSync } = await import("node:fs");
const { claimWorkerLock } = await import(modulePath);
process.stdout.write("ready\\n");
while (!existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 1));
const releaseLock = claimWorkerLock("dictation");
if (releaseLock === null) {
  process.stdout.write("busy\\n");
} else {
  process.stdout.write("owner\\n");
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  releaseLock();
}
`;

const startStarter = (request: { readonly go: string; readonly holdMs: number }) => {
  const child = spawn(
    process.execPath,
    [
      ...["--import", "tsx", "--input-type=module", "-e", STARTER],
      ...[workerProcessesModule, request.go, String(request.holdMs), "worker", "dictation"],
    ],
    { cwd: repositoryRoot, env: { ...process.env, AGENT_VOICE_HOME: home }, stdio: ["ignore", "pipe", "inherit"] },
  );
  started.push(child);
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { pid: child.pid || 0, stdoutSoFar: () => stdout, exited };
};

describe("worker lock", () => {
  it.skipIf(!isMacOS)(
    "lets exactly one of eight racing starters own the lock, even over a lock left by a SIGKILLed owner",
    async () => {
      const go = readHomeFile("go");
      const lockFile = readHomeFile("dictation.lock");
      const pidFile = readHomeFile("dictation.pid");
      writeFileSync(go, "");
      const crashed = startStarter({ go, holdMs: 60_000 });
      expect(await waitUntilTrue(() => crashed.stdoutSoFar().includes("owner"), 20_000)).toBe(true);
      process.kill(crashed.pid, "SIGKILL");
      await crashed.exited;
      expect(existsSync(lockFile)).toBe(true);
      expect(readFileSync(pidFile, "utf8")).toBe(String(crashed.pid));
      rmSync(go);

      const racers = Array.from({ length: 8 }, () => startStarter({ go, holdMs: 2_000 }));
      expect(await waitUntilTrue(() => racers.every((racer) => racer.stdoutSoFar().includes("ready")), 20_000)).toBe(
        true,
      );
      writeFileSync(go, "");
      expect(await waitUntilTrue(() => racers.some((racer) => racer.stdoutSoFar().includes("owner")), 20_000)).toBe(
        true,
      );
      const owner = racers.find((racer) => racer.stdoutSoFar().includes("owner"));
      expect(readFileSync(pidFile, "utf8")).toBe(String(owner?.pid));

      for (const racer of racers) {
        await racer.exited;
      }
      expect(racers.map((racer) => racer.stdoutSoFar().replace("ready\n", "")).sort()).toEqual([
        "busy\n",
        "busy\n",
        "busy\n",
        "busy\n",
        "busy\n",
        "busy\n",
        "busy\n",
        "owner\n",
      ]);
      expect(existsSync(lockFile)).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
    },
  );
});
