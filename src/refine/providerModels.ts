/** Which refine providers are installed on this Mac, and which model IDs each one offers. */

import { homedir } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";

import { readJsonFile, readTextIfReadable } from "../files/stateFiles.js";
import { dedupe, findFirstCli, runCliLines } from "./agentCli.js";
import { codexLastGoodModel } from "./refineChoices.js";

export const providerIdSchema = Schema.Literal("codex", "claude", "gemini", "grok", "ollama", "opencode", "pi");

export type ProviderId = Schema.Schema.Type<typeof providerIdSchema>;

/** Tried in order when the requested Codex model is missing or not allowed for this account; fast first. */
export const CODEX_MODEL_FALLBACKS = [
  "gpt-5.3-codex-spark",
  "gpt-5.4-mini",
  "gpt-5.6-terra",
  "gpt-5.1-codex-mini",
  "o4-mini",
  "gpt-4.1-mini",
];

/** Offered by the picker after the live ~/.codex/models_cache.json entries. */
export const CODEX_PICKER_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5.3-codex-spark",
  "gpt-5.1-codex-mini",
  "o4-mini",
  "gpt-4.1-mini",
  "gpt-4.1",
];

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

// Short timeouts so discovery never hangs on a slow CLI; listings run in parallel.
const LISTING_TIMEOUT_MS = 12_000;
const HELP_TIMEOUT_MS = 5_000;

const listLines = (request: { readonly executable: string; readonly args: ReadonlyArray<string> }) =>
  runCliLines({ ...request, timeoutMs: LISTING_TIMEOUT_MS });

const containsAny = (text: string, markers: ReadonlyArray<string>) =>
  markers.some((marker) => text.toLowerCase().includes(marker));

const codexModelsCacheSchema = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.optional(Schema.String),
      id: Schema.optional(Schema.String),
      visibility: Schema.optional(Schema.String),
    }),
  ),
});

/** The live account catalog the Codex CLI caches in ~/.codex/models_cache.json. */
export const codexCachedModels = (): ReadonlyArray<string> =>
  Option.match(
    readJsonFile({ path: path.join(homedir(), ".codex", "models_cache.json"), schema: codexModelsCacheSchema }),
    {
      onNone: () => [],
      onSome: (cache) =>
        cache.models
          .filter((row) => !["hide", "hidden", "never"].includes((row.visibility || "list").trim().toLowerCase()))
          .map((row) => (row.slug || row.id || "").trim())
          .filter((slug) => slug !== ""),
    },
  );

const codexConfiguredModel = (): ReadonlyArray<string> => {
  const config = Option.getOrElse(readTextIfReadable(path.join(homedir(), ".codex", "config.toml")), () => "");
  const modelLine = config
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("model") && !line.startsWith("model_") && line.includes("="));
  const model = (modelLine || "")
    .split("=")
    .slice(1)
    .join("=")
    .trim()
    .replace(/^["']|["']$/gu, "");
  return model === "" ? [] : [model];
};

const listCodexModels = Effect.sync(() =>
  dedupe([
    ...codexConfiguredModel(),
    ...codexCachedModels(),
    codexLastGoodModel(),
    ...CODEX_PICKER_MODELS,
    ...CODEX_MODEL_FALLBACKS,
  ]),
);

const listOllamaModels = Effect.map(listLines({ executable: "ollama", args: ["list"] }), (lines) =>
  lines
    .slice(1)
    .map((line) => line.split(/\s+/u)[0] || "")
    .filter((name) => name !== "" && name.toUpperCase() !== "NAME"),
);

const CLAUDE_FALLBACK = ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5", "sonnet", "opus", "haiku"];

const claudeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !line.toLowerCase().startsWith("usage") && !line.startsWith("-"))
    .flatMap((line) => [
      ...(line.match(/\bclaude-[\w.-]+\b/gu) || []),
      ...line.split(/[\s,|]+/u).filter((part) => ["sonnet", "opus", "haiku"].includes(part)),
    ]);

const listClaudeModels = Effect.gen(function* () {
  for (const args of [["models"], ["--list-models"]]) {
    const lines = yield* listLines({ executable: "claude", args });
    if (containsAny(lines.join("\n"), ["not logged in", "please run /login", "please login"])) {
      return CLAUDE_FALLBACK;
    }

    const tokens = claudeModelTokens(lines);
    if (tokens.length > 0) {
      return dedupe(tokens);
    }
  }
  return CLAUDE_FALLBACK;
});

// agy prints IDs glued to their Title Case label: "gemini-3.6-flash-highGemini 3.6 Flash (High)".
const unglueLabel = (text: string): string => (text.split(/(?<=[a-z0-9])(?=[A-Z][a-z])/u)[0] || "").trim();

const GEMINI_FALLBACK = [
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

const agyModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !/^(?:usage|fetching|error|options)/iu.test(line))
    .map((line) => (unglueLabel(line).split(/\s+/u)[0] || "").replace(/^[()[\],]+|[()[\],]+$/gu, ""))
    .filter((token) => /^(?:gemini-|claude-|gpt-)/u.test(token));

// Models of the CLI refine runs (gemini before agy): agy's list also holds Claude and GPT IDs that gemini rejects.
const listGeminiModels = Effect.gen(function* () {
  const cli = findFirstCli(["gemini", "agy"]);
  if (Option.isNone(cli)) {
    return GEMINI_FALLBACK;
  }

  if (cli.value.name === "agy") {
    const found = agyModelTokens(yield* listLines({ executable: cli.value.path, args: ["models"] }));
    if (found.length > 0) {
      return dedupe(found).slice(0, 80);
    }
  }

  const help = yield* runCliLines({ executable: cli.value.path, args: ["--help"], timeoutMs: HELP_TIMEOUT_MS });
  const found = help.flatMap((line) => (line.match(/gemini-[\w.-]+/gu) || []).map(unglueLabel));
  return found.length > 0 ? dedupe(found).slice(0, 80) : GEMINI_FALLBACK;
});

const grokModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const afterHeading = lines.findIndex((line) => line.toLowerCase().includes("available model"));
  const listed =
    afterHeading < 0
      ? []
      : lines
          .slice(afterHeading + 1)
          .map((line) => (line.replace(/^[\s*•-]+/u, "").split(/\s+/u)[0] || "").replace(/^[()[\],]+|[()[\],]+$/gu, ""))
          .filter((token) => token.startsWith("grok-"));
  return dedupe([...listed, ...lines.flatMap((line) => line.match(/\bgrok-[\w.-]+\b/gu) || [])]);
};

const listGrokModels = Effect.gen(function* () {
  const grokLines = yield* listLines({ executable: "grok", args: ["models"] });
  const lines = grokLines.length > 0 ? grokLines : yield* listLines({ executable: "agent", args: ["models"] });
  const tokens = grokModelTokens(lines);
  if (tokens.length > 0) {
    return tokens;
  }

  const help = yield* runCliLines({ executable: "grok", args: ["--help"], timeoutMs: HELP_TIMEOUT_MS });
  const fromHelp = dedupe(help.flatMap((line) => line.match(/\bgrok-[\w.-]+\b/gu) || []));
  return fromHelp.length > 0 ? fromHelp : ["grok-4.5", "grok-4", "grok-3", "grok-3-mini"];
});

const opencodeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !/^(?:usage|error|options)/iu.test(line))
    .flatMap((line) =>
      /^[\w.-]+\/[\w.-]+$/u.test(line)
        ? [line]
        : (line.match(/[\w.-]+\/[\w.-]+/gu) || []).filter((token) => !token.includes("http")),
    );

const listOpencodeModels = Effect.gen(function* () {
  for (const args of [["models"], ["model", "list"]]) {
    const found = opencodeModelTokens(yield* listLines({ executable: "opencode", args }));
    if (found.length > 0) {
      return dedupe(found).slice(0, 80);
    }
  }
  return [];
});

// OAuth providers (codex, copilot) usually work; OpenRouter often needs credits.
const piRank = (token: string): number => {
  const lower = token.toLowerCase();
  if (lower.includes("openrouter")) {
    return 9;
  }

  const rank = ["openai-codex/", "github-copilot/", "kimi"].findIndex((prefix) => lower.startsWith(prefix));
  return rank < 0 ? 5 : rank;
};

const piModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !/^(?:usage|options|commands|pi |use |see:|error|provider)/iu.test(line))
    .filter((line) => !containsAny(line, ["login", "api key", "providers.md", "models.md"]))
    .flatMap((line) => {
      const slashTokens = (line.match(/\b[a-z][\w.-]*\/[\w.:-]+\b/giu) || []).filter(
        (token) => !token.toLowerCase().includes("http"),
      );
      if (slashTokens.length > 0) {
        return slashTokens;
      }

      const [provider = "", model = ""] = line.split(/\s+/u);
      const isModelRow =
        model !== "" &&
        !provider.startsWith("-") &&
        !["context", "max-out", "thinking", "images"].includes(model) &&
        !model.toLowerCase().includes("http");
      return isModelRow ? [`${provider}/${model}`] : [];
    });

/** provider/model IDs from the `pi --list-models` table ("openai-codex  gpt-5.4-mini  272K …"), from pi or pie. */
const listPiModels = Effect.map(
  Effect.suspend(() =>
    listLines({
      executable: Option.match(findFirstCli(["pi", "pie"]), { onNone: () => "pi", onSome: (found) => found.path }),
      args: ["--list-models"],
    }),
  ),
  (lines) => {
    if (containsAny(lines.join("\n"), ["no models available", "no api key", "use /login", "not logged in"])) {
      return ["default"];
    }

    const ranked = [...dedupe(piModelTokens(lines))].sort(
      (left, right) => piRank(left) - piRank(right) || left.localeCompare(right),
    );
    return ranked.length > 0 ? ranked.slice(0, 80) : ["default"];
  },
);

type ProviderSpec = {
  readonly id: ProviderId;
  readonly binaries: ReadonlyArray<string>;
  readonly effort: boolean;
  readonly listModels: Effect.Effect<ReadonlyArray<string>>;
};

// id → binary names (first found wins), reasoning-effort support, model lister.
const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  { id: "codex", binaries: ["codex"], effort: true, listModels: listCodexModels },
  { id: "claude", binaries: ["claude"], effort: false, listModels: listClaudeModels },
  { id: "gemini", binaries: ["gemini", "agy"], effort: true, listModels: listGeminiModels },
  { id: "grok", binaries: ["grok", "agent"], effort: true, listModels: listGrokModels },
  { id: "ollama", binaries: ["ollama"], effort: false, listModels: listOllamaModels },
  { id: "opencode", binaries: ["opencode"], effort: true, listModels: listOpencodeModels },
  { id: "pi", binaries: ["pi", "pie"], effort: true, listModels: listPiModels },
];

export const discoveredProviderSchema = Schema.Struct({
  id: providerIdSchema,
  binary: Schema.String,
  path: Schema.String,
  effort: Schema.Boolean,
  models: Schema.Array(Schema.String),
});

export type DiscoveredProvider = Schema.Schema.Type<typeof discoveredProviderSchema>;

export const isProviderInstalled = (provider: ProviderId): boolean =>
  PROVIDERS.some((spec) => spec.id === provider && Option.isSome(findFirstCli(spec.binaries)));

export const providerModels = (provider: ProviderId): Effect.Effect<ReadonlyArray<string>> =>
  Option.match(Option.fromNullable(PROVIDERS.find((spec) => spec.id === provider)), {
    onNone: () => Effect.succeed([]),
    onSome: (spec) => spec.listModels,
  });

const describeProvider = (spec: ProviderSpec) =>
  Option.match(findFirstCli(spec.binaries), {
    onNone: () => Effect.succeed(Option.none<DiscoveredProvider>()),
    onSome: (cli) =>
      Effect.map(spec.listModels, (models) =>
        Option.some({
          id: spec.id,
          binary: cli.name,
          path: cli.path,
          effort: spec.effort,
          models: models.length > 0 ? [...models] : ["default"],
        }),
      ),
  });

const DISCOVERY_CACHE_MS = 120_000;

let discovered: { readonly at: number; readonly providers: ReadonlyArray<DiscoveredProvider> } | undefined;

/** Installed providers and their models, listed in parallel and remembered for two minutes. */
export const discoverProviders = (request: {
  readonly refresh: boolean;
}): Effect.Effect<ReadonlyArray<DiscoveredProvider>> =>
  Effect.gen(function* () {
    const cached = discovered;
    if (!request.refresh && cached !== undefined && Date.now() - cached.at < DISCOVERY_CACHE_MS) {
      return cached.providers;
    }

    const providers = (yield* Effect.forEach(PROVIDERS, describeProvider, { concurrency: 8 })).flatMap(Option.toArray);
    discovered = { at: Date.now(), providers };
    return providers;
  });
