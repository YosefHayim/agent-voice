import { chmodSync, mkdirSync, type PathLike, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { type DiscoveredProvider, discoverProviders } from "./providerModels.js";
import { attemptQueue, codexModelCandidates, refinePrompt, shouldRotate } from "./refineAttempts.js";
import { codexFailedModels } from "./refineChoices.js";
import { pickerModels } from "./refinePicker.js";
import { refineWithProvider } from "./refineProviders.js";

// findCli also searches /usr/local/bin and /opt/homebrew/bin, outside the fake PATH. A CLI installed there on this
// Mac (a real `pi`, say) stays invisible, so no test finds it in place of a fake or ever runs it.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const isHostBin = (file: PathLike) =>
    ["/usr/local/bin/", "/opt/homebrew/bin/"].some((folder) => String(file).startsWith(folder));
  return {
    ...fs,
    accessSync: (file: PathLike, mode?: number) => {
      if (isHostBin(file)) {
        throw new Error(`${String(file)} is hidden from the refine tests`);
      }
      fs.accessSync(file, mode);
    },
  };
});

const PROVIDER_BINARIES = ["codex", "claude", "gemini", "agy", "grok", "agent", "ollama", "opencode", "pi", "pie"];

let home = "";
let bin = "";

// Every provider binary gets a fake first on PATH, so no test can reach a real agent CLI.
const writeFakeCli = (name: string, script: string) => {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
};

beforeEach(() => {
  home = makeTestFolder("refine");
  bin = path.join(home, "bin");
  mkdirSync(bin);
  for (const name of PROVIDER_BINARIES) {
    writeFakeCli(name, "exit 0");
  }
  const voxkeyHome = path.join(home, ".voxkey");
  vi.stubEnv("HOME", home);
  vi.stubEnv("VOXKEY_HOME", voxkeyHome);
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// A fake codex that writes its reply to the `-o` file, or fails for the models listed in BAD_MODELS.
const fakeCodex = (request: { readonly reply: string; readonly badModels: ReadonlyArray<string> }) => {
  const script = [
    'out=""; model=""; prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "-o" ]; then out="$arg"; fi',
    '  if [ "$prev" = "-m" ]; then model="$arg"; fi',
    '  prev="$arg"',
    "done",
    `case " ${request.badModels.join(" ")} " in *" $model "*) echo "ERROR: The '$model' model is not supported when using Codex with a ChatGPT account."; exit 1;; esac`,
    `printf '%s' '${request.reply}' > "$out"`,
  ].join("\n");
  writeFakeCli("codex", script);
};

const refine = (draft: string) => {
  const refining = refinePrompt({
    draft,
    provider: "codex",
    model: "",
    effort: "",
    allowPicker: false,
    log: () => undefined,
  });
  return Effect.runPromiseExit(refining);
};

describe("codexModelCandidates", () => {
  it("tries the preferred model first, then the last good one, then the fallbacks", () => {
    const candidates = codexModelCandidates({ preferred: "my-model", lastGood: "gpt-5.4-mini", failed: new Set() });
    expect(candidates.slice(0, 3)).toEqual(["my-model", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
  });

  it("starts with the last good model when the preferred one already failed, and defers failed models", () => {
    const candidates = codexModelCandidates({
      preferred: "gpt-5.3-codex-spark",
      lastGood: "gpt-5.4-mini",
      failed: new Set(["gpt-5.3-codex-spark", "o4-mini"]),
    });
    expect(candidates[0]).toBe("gpt-5.4-mini");
    expect(candidates.slice(-2)).toEqual(["gpt-5.3-codex-spark", "o4-mini"]);
  });
});

describe("refine rotation", () => {
  it("rotates on errors and model-unavailable replies but not on a dropped literal", () => {
    expect(shouldRotate("connection refused")).toBe(true);
    expect(shouldRotate("The model is not supported")).toBe(true);
    expect(shouldRotate("The model changed a protected literal: `x`")).toBe(false);
  });

  it("puts the preferred provider's models first, then one model from each other installed provider", async () => {
    writeFakeCli("pi", 'echo "openai-codex  gpt-5.4-mini  272K"; echo "openrouter  slow  128K"');
    writeFakeCli("opencode", 'echo "opencode/big-pickle"');
    const queuing = attemptQueue({ provider: "pi", model: "default" });
    const queue = await Effect.runPromise(queuing);

    expect(queue[0]).toEqual({ provider: "pi", model: "openai-codex/gpt-5.4-mini" });
    expect(queue.map((attempt) => attempt.provider)).toEqual(
      expect.arrayContaining(["pi", "codex", "opencode", "gemini", "grok"]),
    );
    expect(queue.find((attempt) => attempt.provider === "opencode")?.model).toBe("opencode/big-pickle");
  });

  it("auto tries the first provider's models, then one model from each of four fallback providers", async () => {
    writeFakeCli("opencode", 'printf "a/one\\na/two\\na/three\\na/four\\n"');
    const queuing = attemptQueue({ provider: "auto", model: "" });
    const queue = await Effect.runPromise(queuing);
    const providers = queue.map((attempt) => attempt.provider);

    expect(providers.filter((provider) => provider === "codex")).toHaveLength(6);
    expect(providers.slice(6)).toEqual(["opencode", "gemini", "grok", "pi"]);
  });

  it("rejects a CLI that exits non-zero instead of typing its error text", async () => {
    writeFakeCli("grok", 'echo "network unreachable, try again later" >&2; exit 1');
    const attempt = { provider: "grok" as const, model: "", effort: "", draft: "make a branch for the login fix" };
    const refining = refineWithProvider(attempt);
    const exit = await Effect.runPromiseExit(refining);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("keeps a failed CLI's stderr in the failure even when it printed to stdout, so the error still rotates", async () => {
    writeFakeCli("grok", 'echo "Here is a cleaner prompt:"; echo "connection refused by the model host" >&2; exit 1');
    const attempt = { provider: "grok" as const, model: "", effort: "", draft: "make a branch for the login fix" };
    const failing = refineWithProvider(attempt).pipe(Effect.flip);
    const failure = await Effect.runPromise(failing);

    expect(failure.detail).toBe("connection refused by the model host\nHere is a cleaner prompt:");
    expect(shouldRotate(failure.detail)).toBe(true);
  });

  it("refines with codex, keeps protected literals, and remembers the working model", async () => {
    fakeCodex({ reply: "finish-and-push: run `pnpm verify` then open a PR", badModels: [] });
    const refined = await refine("uh run `pnpm verify` and like open a pr dont merge");

    expect(refined).toEqual(Exit.succeed("finish-and-push: run `pnpm verify` then open a PR"));
    const choiceFile = path.join(home, ".voxkey", "refine-choice.json");
    const choiceText = readFileSync(choiceFile, "utf8");
    const choice = JSON.parse(choiceText);
    expect(choice).toMatchObject({ provider: "codex", model: "gpt-5.3-codex-spark", effort: "low" });
  });

  it("marks a model this account cannot use and moves on to the next one", async () => {
    fakeCodex({ reply: "Ship the voice refine fix", badModels: ["gpt-5.3-codex-spark"] });
    const refined = await refine("uh ship the voice refine fix please now");

    expect(refined).toEqual(Exit.succeed("Ship the voice refine fix"));
    expect([...codexFailedModels()]).toEqual(["gpt-5.3-codex-spark"]);
  });

  it("fails without typing anything when every provider prints an error envelope", async () => {
    for (const name of PROVIDER_BINARIES) {
      writeFakeCli(name, 'echo \'{"error":{"code":402,"message":"requires more credits"}}\'');
    }
    const refined = await refine("make a branch and open a pull request");
    expect(Exit.isFailure(refined)).toBe(true);
  });
});

describe("discoverProviders", () => {
  it("lists models from the same CLI refine runs: gemini before agy, and pie when pi is missing", async () => {
    writeFakeCli("gemini", 'echo "  -m, --model   e.g. gemini-2.5-pro"');
    writeFakeCli("agy", 'echo "claude-sonnet-4-5Claude Sonnet 4.5"');
    const fakePi = path.join(bin, "pi");
    rmSync(fakePi);
    writeFakeCli("pie", 'echo "openai-codex  gpt-5.4-mini  272K"');
    const discovering = discoverProviders({ refresh: true });
    const providers = await Effect.runPromise(discovering);

    expect(providers.find((provider) => provider.id === "gemini")?.models).toEqual(["gemini-2.5-pro"]);
    expect(providers.find((provider) => provider.id === "pi")).toMatchObject({
      binary: "pie",
      models: ["openai-codex/gpt-5.4-mini"],
    });
  });

  it("lists installed providers with their models", async () => {
    writeFakeCli("ollama", 'echo "NAME ID SIZE"; echo "llama3.2:latest abc 2.0 GB"');
    const discovering = discoverProviders({ refresh: true });
    const providers = await Effect.runPromise(discovering);
    const ollama = providers.find((provider) => provider.id === "ollama");

    expect(ollama).toEqual({
      id: "ollama",
      binary: "ollama",
      path: path.join(bin, "ollama"),
      effort: false,
      models: ["llama3.2:latest"],
    });
    expect(providers.map((provider) => provider.id)).toEqual([
      "codex",
      "claude",
      "gemini",
      "grok",
      "ollama",
      "opencode",
      "pi",
    ]);
  });
});

describe("pickerModels", () => {
  const providers: ReadonlyArray<DiscoveredProvider> = [
    { id: "opencode", binary: "opencode", path: "/bin/opencode", effort: true, models: ["opencode/big-pickle"] },
    { id: "codex", binary: "codex", path: "/bin/codex", effort: true, models: ["gpt-5.4-mini"] },
  ];

  it("offers the preferred model first only for its own provider", () => {
    expect(
      pickerModels({ provider: "opencode", providers, preferred: { provider: "codex", model: "gpt-5.5" } }),
    ).toEqual(["opencode/big-pickle"]);
    expect(
      pickerModels({ provider: "opencode", providers, preferred: { provider: "opencode", model: "opencode/grok" } }),
    ).toEqual(["opencode/grok", "opencode/big-pickle"]);
  });

  it("never offers a model saved for another provider as a Codex model", () => {
    const voxkeyHome = path.join(home, ".voxkey");
    const choiceFile = path.join(voxkeyHome, "refine-choice.json");
    const savedChoice = JSON.stringify({ provider: "claude", model: "opus", effort: "", updatedAt: 1 });
    mkdirSync(voxkeyHome, { recursive: true });
    writeFileSync(choiceFile, savedChoice);

    expect(
      pickerModels({ provider: "codex", providers, preferred: { provider: "claude", model: "opus" } }),
    ).not.toContain("opus");
  });
});
