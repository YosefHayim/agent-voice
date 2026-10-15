import { homedir } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";

import { readJsonFile, readTextIfReadable } from "../files/stateFiles.js";
import { containsAny, dedupe, findFirstCli, nonBlankLines, runCliLines } from "./agentCli.js";
import { codexLastGoodModel } from "./refineChoices.js";

export const providerIdSchema = Schema.Literal("codex", "claude", "gemini", "grok", "ollama", "opencode", "pi");

export type ProviderId = Schema.Schema.Type<typeof providerIdSchema>;

// Tried in order when the requested Codex model is missing or not allowed for this account; fast first.
export const CODEX_MODEL_FALLBACKS = [
  "gpt-5.3-codex-spark",
  "gpt-5.4-mini",
  "gpt-5.6-terra",
  "gpt-5.1-codex-mini",
  "o4-mini",
  "gpt-4.1-mini",
];

// Offered by the picker after the live ~/.codex/models_cache.json entries.
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
const MAX_LISTED_MODELS = 80;

const EDGE_BRACKETS = /^[()[\],]+|[()[\],]+$/gu;

const listLines = (request: { readonly executable: string; readonly args: ReadonlyArray<string> }) =>
  runCliLines({ ...request, timeoutMs: LISTING_TIMEOUT_MS });

const helpLines = (executable: string) => runCliLines({ executable, args: ["--help"], timeoutMs: HELP_TIMEOUT_MS });

const matchesOf = (text: string, pattern: RegExp): ReadonlyArray<string> => text.match(pattern) || [];

const firstWord = (text: string): string => text.split(/\s+/u)[0] || "";

const bareWord = (text: string): string => firstWord(text).replace(EDGE_BRACKETS, "");

const topModels = (tokens: ReadonlyArray<string>): ReadonlyArray<string> => dedupe(tokens).slice(0, MAX_LISTED_MODELS);

const codexFile = (name: string): string => {
  const home = homedir();
  return path.join(home, ".codex", name);
};

const codexCachedModelSchema = Schema.Struct({
  slug: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  visibility: Schema.optional(Schema.String),
});

const codexModelsCacheSchema = Schema.Struct({ models: Schema.Array(codexCachedModelSchema) });

type CodexCachedModel = Schema.Schema.Type<typeof codexCachedModelSchema>;

const HIDDEN_VISIBILITIES = ["hide", "hidden", "never"];

const isVisibleModel = (model: CodexCachedModel): boolean => {
  const visibility = (model.visibility || "list").trim().toLowerCase();
  return !HIDDEN_VISIBILITIES.includes(visibility);
};

const modelSlug = (model: CodexCachedModel): string => (model.slug || model.id || "").trim();

// The live account catalog the Codex CLI caches.
export const codexCachedModels = (): ReadonlyArray<string> => {
  const cacheFile = codexFile("models_cache.json");
  const cache = readJsonFile({ path: cacheFile, schema: codexModelsCacheSchema });
  return cache.pipe(
    Option.map((cached) =>
      cached.models
        .filter(isVisibleModel)
        .map(modelSlug)
        .filter((slug) => slug !== ""),
    ),
    Option.getOrElse(() => []),
  );
};

const isModelSetting = (line: string): boolean =>
  line.startsWith("model") && !line.startsWith("model_") && line.includes("=");

const codexConfiguredModel = (): ReadonlyArray<string> => {
  const configFile = codexFile("config.toml");
  const config = readTextIfReadable(configFile).pipe(Option.getOrElse(() => ""));
  const modelLine = nonBlankLines(config).find(isModelSetting);
  const model = (modelLine || "")
    .split("=")
    .slice(1)
    .join("=")
    .trim()
    .replace(/^["']|["']$/gu, "");
  if (model === "") {
    return [];
  }

  return [model];
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

const ollamaModelNames = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .slice(1)
    .map(firstWord)
    .filter((name) => name !== "" && name.toUpperCase() !== "NAME");

const listOllamaModels = listLines({ executable: "ollama", args: ["list"] }).pipe(Effect.map(ollamaModelNames));

const CLAUDE_FALLBACK = ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5", "sonnet", "opus", "haiku"];
const CLAUDE_ALIASES = ["sonnet", "opus", "haiku"];
const CLAUDE_LOGGED_OUT_MARKERS = ["not logged in", "please run /login", "please login"];

const claudeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !line.toLowerCase().startsWith("usage") && !line.startsWith("-"))
    .flatMap((line) => [
      ...matchesOf(line, /\bclaude-[\w.-]+\b/gu),
      ...line.split(/[\s,|]+/u).filter((part) => CLAUDE_ALIASES.includes(part)),
    ]);

const listClaudeModels = Effect.gen(function* () {
  for (const args of [["models"], ["--list-models"]]) {
    const lines = yield* listLines({ executable: "claude", args });
    const listing = lines.join("\n");
    const isLoggedOut = containsAny(listing, CLAUDE_LOGGED_OUT_MARKERS);
    if (isLoggedOut) {
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
    .map(unglueLabel)
    .map(bareWord)
    .filter((token) => /^(?:gemini-|claude-|gpt-)/u.test(token));

// Only agy has a models command; gemini names its models in its help text.
const listAgyModels = (cli: { readonly name: string; readonly path: string }): Effect.Effect<ReadonlyArray<string>> => {
  const isAgy = cli.name === "agy";
  if (!isAgy) {
    return Effect.succeed([]);
  }

  return listLines({ executable: cli.path, args: ["models"] }).pipe(Effect.map(agyModelTokens));
};

// Models of the CLI refine runs (gemini before agy): agy's list also holds Claude and GPT IDs that gemini rejects.
const listGeminiModels = Effect.gen(function* () {
  const cli = findFirstCli(["gemini", "agy"]);
  if (Option.isNone(cli)) {
    return GEMINI_FALLBACK;
  }

  const agyModels = yield* listAgyModels(cli.value);
  if (agyModels.length > 0) {
    return topModels(agyModels);
  }

  const help = yield* helpLines(cli.value.path);
  const helpModels = help.flatMap((line) => matchesOf(line, /gemini-[\w.-]+/gu).map(unglueLabel));
  if (helpModels.length === 0) {
    return GEMINI_FALLBACK;
  }

  return topModels(helpModels);
});

const GROK_FALLBACK = ["grok-4.5", "grok-4", "grok-3", "grok-3-mini"];
const GROK_MODEL = /\bgrok-[\w.-]+\b/gu;

const grokListedModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const headingIndex = lines.findIndex((line) => line.toLowerCase().includes("available model"));
  if (headingIndex < 0) {
    return [];
  }

  return lines
    .slice(headingIndex + 1)
    .map((line) => line.replace(/^[\s*•-]+/u, ""))
    .map(bareWord)
    .filter((token) => token.startsWith("grok-"));
};

const grokMentionedModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.flatMap((line) => matchesOf(line, GROK_MODEL));

const grokModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const listed = grokListedModels(lines);
  const mentioned = grokMentionedModels(lines);
  return dedupe([...listed, ...mentioned]);
};

const grokListing = Effect.gen(function* () {
  const grokLines = yield* listLines({ executable: "grok", args: ["models"] });
  if (grokLines.length > 0) {
    return grokLines;
  }

  return yield* listLines({ executable: "agent", args: ["models"] });
});

const listGrokModels = Effect.gen(function* () {
  const lines = yield* grokListing;
  const tokens = grokModelTokens(lines);
  if (tokens.length > 0) {
    return tokens;
  }

  const help = yield* helpLines("grok");
  const mentioned = grokMentionedModels(help);
  const helpModels = dedupe(mentioned);
  if (helpModels.length === 0) {
    return GROK_FALLBACK;
  }

  return helpModels;
});

const opencodeLineModels = (line: string): ReadonlyArray<string> => {
  const isModelLine = /^[\w.-]+\/[\w.-]+$/u.test(line);
  if (isModelLine) {
    return [line];
  }

  return matchesOf(line, /[\w.-]+\/[\w.-]+/gu).filter((token) => !token.includes("http"));
};

const opencodeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => !/^(?:usage|error|options)/iu.test(line)).flatMap(opencodeLineModels);

const listOpencodeModels = Effect.gen(function* () {
  for (const args of [["models"], ["model", "list"]]) {
    const lines = yield* listLines({ executable: "opencode", args });
    const found = opencodeModelTokens(lines);
    if (found.length > 0) {
      return topModels(found);
    }
  }

  return [];
});

// OAuth providers (codex, copilot) usually work; OpenRouter often needs credits.
const PI_PREFERRED_PREFIXES = ["openai-codex/", "github-copilot/", "kimi"];
const PI_TABLE_COLUMNS = ["context", "max-out", "thinking", "images"];
const PI_HINT_MARKERS = ["login", "api key", "providers.md", "models.md"];
const PI_LOGGED_OUT_MARKERS = ["no models available", "no api key", "use /login", "not logged in"];

const piRank = (token: string): number => {
  const lowercase = token.toLowerCase();
  if (lowercase.includes("openrouter")) {
    return 9;
  }

  const rank = PI_PREFERRED_PREFIXES.findIndex((prefix) => lowercase.startsWith(prefix));
  if (rank < 0) {
    return 5;
  }

  return rank;
};

const byPiRank = (left: string, right: string): number => piRank(left) - piRank(right) || left.localeCompare(right);

const piLineModels = (line: string): ReadonlyArray<string> => {
  const slashTokens = matchesOf(line, /\b[a-z][\w.-]*\/[\w.:-]+\b/giu).filter(
    (token) => !token.toLowerCase().includes("http"),
  );
  if (slashTokens.length > 0) {
    return slashTokens;
  }

  const [provider = "", model = ""] = line.split(/\s+/u);
  const isModelRow =
    model !== "" &&
    !provider.startsWith("-") &&
    !PI_TABLE_COLUMNS.includes(model) &&
    !model.toLowerCase().includes("http");
  if (!isModelRow) {
    return [];
  }

  return [`${provider}/${model}`];
};

const piModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !/^(?:usage|options|commands|pi |use |see:|error|provider)/iu.test(line))
    .filter((line) => !containsAny(line, PI_HINT_MARKERS))
    .flatMap(piLineModels);

const rankPiModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const listing = lines.join("\n");
  const isLoggedOut = containsAny(listing, PI_LOGGED_OUT_MARKERS);
  if (isLoggedOut) {
    return ["default"];
  }

  const tokens = piModelTokens(lines);
  const uniqueTokens = dedupe(tokens);
  const ranked = [...uniqueTokens].sort(byPiRank);
  if (ranked.length === 0) {
    return ["default"];
  }

  return ranked.slice(0, MAX_LISTED_MODELS);
};

const piExecutable = (): string =>
  findFirstCli(["pi", "pie"]).pipe(Option.match({ onNone: () => "pi", onSome: (found) => found.path }));

// provider/model IDs from the `pi --list-models` table ("openai-codex  gpt-5.4-mini  272K ..."), from pi or pie.
const listPiModels = Effect.suspend(() => {
  const executable = piExecutable();
  return listLines({ executable, args: ["--list-models"] });
}).pipe(Effect.map(rankPiModels));

type ProviderSpec = {
  readonly id: ProviderId;
  readonly binaries: ReadonlyArray<string>;
  readonly effort: boolean;
  readonly listModels: Effect.Effect<ReadonlyArray<string>>;
};

// id, binary names (first found wins), reasoning-effort support, model lister.
const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  { id: "codex", binaries: ["codex"], effort: true, listModels: listCodexModels },
  { id: "claude", binaries: ["claude"], effort: false, listModels: listClaudeModels },
  { id: "gemini", binaries: ["gemini", "agy"], effort: true, listModels: listGeminiModels },
  { id: "grok", binaries: ["grok", "agent"], effort: true, listModels: listGrokModels },
  { id: "ollama", binaries: ["ollama"], effort: false, listModels: listOllamaModels },
  { id: "opencode", binaries: ["opencode"], effort: true, listModels: listOpencodeModels },
  { id: "pi", binaries: ["pi", "pie"], effort: true, listModels: listPiModels },
];

const discoveredProviderSchema = Schema.Struct({
  id: providerIdSchema,
  binary: Schema.String,
  path: Schema.String,
  effort: Schema.Boolean,
  models: Schema.Array(Schema.String),
});

export type DiscoveredProvider = Schema.Schema.Type<typeof discoveredProviderSchema>;

const providerSpec = (provider: ProviderId): Option.Option<ProviderSpec> => {
  const spec = PROVIDERS.find((candidate) => candidate.id === provider);
  return Option.fromNullable(spec);
};

export const isProviderInstalled = (provider: ProviderId): boolean =>
  providerSpec(provider).pipe(
    Option.flatMap((spec) => findFirstCli(spec.binaries)),
    Option.isSome,
  );

export const providerModels = (provider: ProviderId): Effect.Effect<ReadonlyArray<string>> =>
  providerSpec(provider).pipe(
    Option.match({
      onNone: () => Effect.succeed([]),
      onSome: (spec) => spec.listModels,
    }),
  );

const withDefaultModel = (models: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (models.length === 0) {
    return ["default"];
  }

  return models;
};

const describeProvider = (spec: ProviderSpec): Effect.Effect<Option.Option<DiscoveredProvider>> => {
  const cli = findFirstCli(spec.binaries);
  if (Option.isNone(cli)) {
    return Effect.succeedNone;
  }

  const installed = cli.value;
  return spec.listModels.pipe(
    Effect.map((models) => ({
      id: spec.id,
      binary: installed.name,
      path: installed.path,
      effort: spec.effort,
      models: withDefaultModel(models),
    })),
    Effect.asSome,
  );
};

const DISCOVERY_CACHE_MS = 120_000;

// Starts stale (at 0), so the first call always lists.
const discoveryCache: { at: number; providers: ReadonlyArray<DiscoveredProvider> } = { at: 0, providers: [] };

// Listed in parallel and remembered for two minutes.
export const discoverProviders = (request: {
  readonly refresh: boolean;
}): Effect.Effect<ReadonlyArray<DiscoveredProvider>> =>
  Effect.gen(function* () {
    const age = Date.now() - discoveryCache.at;
    const isFresh = !request.refresh && age < DISCOVERY_CACHE_MS;
    if (isFresh) {
      return discoveryCache.providers;
    }

    const described = yield* Effect.forEach(PROVIDERS, describeProvider, { concurrency: 8 });
    const providers = described.flatMap(Option.toArray);
    discoveryCache.at = Date.now();
    discoveryCache.providers = providers;
    return providers;
  });
