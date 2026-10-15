import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isWorkerRunning, stopWorkers } from "./workerProcesses.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scratchRoot = path.join(repositoryRoot, ".scratch");
const workerProcessesModule = fileURLToPath(new URL("./workerProcesses.js", import.meta.url));

let home = "";
const started: Array<ChildProcess> = [];

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "workers-"));
  vi.stubEnv("VOXKEY_HOME", home);
});

// Only processes this test started are ever signalled, here or by voxkey.
afterEach(() => {
  for (const child of started.splice(0)) {
    child.kill("SIGKILL");
  }
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A sleeping Node process whose command line ends with `trailing`, e.g. ["worker", "dictation"]. */
const startSleeper = async (trailing: ReadonlyArray<string>): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", ...trailing], {
    stdio: "ignore",
    detached: true,
  });
  started.push(child);
  await new Promise((resolve) => child.once("spawn", resolve));
  return child.pid || 0;
};

const writePidFile = (name: string, pid: number) => writeFileSync(path.join(home, name), String(pid));

const eventually = async (check: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
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
    expect(await eventually(() => isWorkerRunning("dictation"))).toBe(true);
    expect(isWorkerRunning("speech")).toBe(false);
  });

  it("stopWorkers never signals a process its pid file does not name, and stops one it does", async () => {
    const stranger = await startSleeper([]);
    for (const name of ["dictation.pid", "pill.pid"]) {
      writePidFile(name, stranger);
    }
    const speech = await startSleeper(["worker", "speech"]);
    writePidFile("speech.pid", speech);
    expect(await eventually(() => isWorkerRunning("speech"))).toBe(true);

    await Effect.runPromise(stopWorkers);

    expect(await eventually(() => !isAlive(speech))).toBe(true);
    expect(isAlive(stranger)).toBe(true);
    expect(existsSync(path.join(home, "dictation.pid"))).toBe(false);
  });
});

// A starter: once the `go` file exists it claims the dictation lock, prints "owner" or "busy", and an owner keeps the
// lock for holdMs, so every racer tries while the winner still holds it. Its command line ends like a real dictation
// worker's, so `ps` takes each starter for one.
const STARTER = `
const [modulePath, go, holdMs] = process.argv.slice(1);
const { existsSync } = await import("node:fs");
const { Effect } = await import("effect");
const { claimWorkerLock } = await import(modulePath);
process.stdout.write("ready\\n");
while (!existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 1));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const owns = yield* claimWorkerLock("dictation");
  process.stdout.write(owns ? "owner\\n" : "busy\\n");
  if (owns) yield* Effect.sleep(Number(holdMs));
})));
`;

const startStarter = (request: { readonly go: string; readonly holdMs: number }) => {
  const child = spawn(
    process.execPath,
    [
      ...["--import", "tsx", "--input-type=module", "-e", STARTER],
      ...[workerProcessesModule, request.go, String(request.holdMs), "worker", "dictation"],
    ],
    { cwd: repositoryRoot, env: { ...process.env, VOXKEY_HOME: home }, stdio: ["ignore", "pipe", "inherit"] },
  );
  started.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { pid: child.pid || 0, output: () => output, exited };
};

describe("worker lock", () => {
  it("lets exactly one of eight racing starters own the lock, even over a lock left by a SIGKILLed owner", async () => {
    const go = path.join(home, "go");
    writeFileSync(go, "");
    const crashed = startStarter({ go, holdMs: 60_000 });
    expect(await eventually(() => crashed.output().includes("owner"), 20_000)).toBe(true);
    process.kill(crashed.pid, "SIGKILL");
    await crashed.exited;
    expect(existsSync(path.join(home, "dictation.lock"))).toBe(true);
    expect(readFileSync(path.join(home, "dictation.pid"), "utf8")).toBe(String(crashed.pid));
    rmSync(go);

    const racers = Array.from({ length: 8 }, () => startStarter({ go, holdMs: 2_000 }));
    expect(await eventually(() => racers.every((racer) => racer.output().includes("ready")), 20_000)).toBe(true);
    writeFileSync(go, "");
    expect(await eventually(() => racers.some((racer) => racer.output().includes("owner")), 20_000)).toBe(true);
    const owner = racers.find((racer) => racer.output().includes("owner"));
    expect(readFileSync(path.join(home, "dictation.pid"), "utf8")).toBe(String(owner?.pid));

    for (const racer of racers) {
      await racer.exited;
    }
    expect(racers.map((racer) => racer.output().replace("ready\n", "")).sort()).toEqual([
      "busy\n",
      "busy\n",
      "busy\n",
      "busy\n",
      "busy\n",
      "busy\n",
      "busy\n",
      "owner\n",
    ]);
    expect(existsSync(path.join(home, "dictation.lock"))).toBe(false);
    expect(existsSync(path.join(home, "dictation.pid"))).toBe(false);
  });
});
