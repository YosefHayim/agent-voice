import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { readJsonFile, readTextIfReadable } from "#src/storage/state-files.js";
import { containsAny, dedupe, findFirstCli, nonBlankLines, runCliLines } from "./agent-cli.js";
import { codexLastGoodModel } from "./refine-choices.js";

export const providerIdSchema = z.enum(["codex", "claude", "gemini", "grok", "ollama", "opencode", "pi"]);

export type ProviderId = z.infer<typeof providerIdSchema>;

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

// A listing has no caller to cancel it, so its own timeout is its signal.
const listLines = (request: { readonly executable: string; readonly args: ReadonlyArray<string> }) =>
  runCliLines({
    ...request,
    timeoutMs: LISTING_TIMEOUT_MS,
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
  });

const helpLines = (executable: string) =>
  runCliLines({
    executable,
    args: ["--help"],
    timeoutMs: HELP_TIMEOUT_MS,
    signal: AbortSignal.timeout(HELP_TIMEOUT_MS),
  });

const findMatches = (line: string, pattern: RegExp): ReadonlyArray<string> => line.match(pattern) ?? [];

const firstWord = (line: string): string => line.split(/\s+/u)[0] ?? "";

const bareWord = (token: string): string => firstWord(token).replace(EDGE_BRACKETS, "");

const topModels = (tokens: ReadonlyArray<string>): ReadonlyArray<string> => dedupe(tokens).slice(0, MAX_LISTED_MODELS);

const codexFile = (name: string): string => {
  const home = homedir();
  return path.join(home, ".codex", name);
};

const codexCachedModelSchema = z.object({
  slug: z.string().optional(),
  id: z.string().optional(),
  visibility: z.string().optional(),
});

const codexModelsCacheSchema = z.object({ models: z.array(codexCachedModelSchema) });

type CodexCachedModel = z.infer<typeof codexCachedModelSchema>;

const HIDDEN_VISIBILITIES = ["hide", "hidden", "never"];

const isVisibleModel = (model: CodexCachedModel): boolean => {
  const visibility = (model.visibility || "list").trim().toLowerCase();
  return !HIDDEN_VISIBILITIES.includes(visibility);
};

const modelSlug = (model: CodexCachedModel): string => (model.slug || model.id || "").trim();

// The live account catalog the Codex CLI caches.
export const codexCachedModels = (): ReadonlyArray<string> => {
  const modelsCache = readJsonFile({ path: codexFile("models_cache.json"), schema: codexModelsCacheSchema });

  const isCacheMissing = modelsCache === null;
  if (isCacheMissing) {
    return [];
  }

  return modelsCache.models
    .filter(isVisibleModel)
    .map(modelSlug)
    .filter((slug) => slug !== "");
};

const isModelSetting = (line: string): boolean =>
  line.startsWith("model") && !line.startsWith("model_") && line.includes("=");

const codexConfiguredModel = (): ReadonlyArray<string> => {
  const configToml = readTextIfReadable(codexFile("config.toml")) ?? "";
  const modelLine = nonBlankLines(configToml).find(isModelSetting);
  const model = (modelLine || "")
    .split("=")
    .slice(1)
    .join("=")
    .trim()
    .replace(/^["']|["']$/gu, "");

  const isModelMissing = model === "";
  if (isModelMissing) {
    return [];
  }

  return [model];
};

const listCodexModels = async (): Promise<ReadonlyArray<string>> =>
  dedupe([
    ...codexConfiguredModel(),
    ...codexCachedModels(),
    codexLastGoodModel(),
    ...CODEX_PICKER_MODELS,
    ...CODEX_MODEL_FALLBACKS,
  ]);

const ollamaModelNames = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .slice(1)
    .map(firstWord)
    .filter((name) => name !== "" && name.toUpperCase() !== "NAME");

const listOllamaModels = async (): Promise<ReadonlyArray<string>> => {
  const ollamaListLines = await listLines({ executable: "ollama", args: ["list"] });
  return ollamaModelNames(ollamaListLines);
};

const CLAUDE_FALLBACK = ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5", "sonnet", "opus", "haiku"];
const CLAUDE_ALIASES = ["sonnet", "opus", "haiku"];
const CLAUDE_LOGGED_OUT_MARKERS = ["not logged in", "please run /login", "please login"];

const claudeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !line.toLowerCase().startsWith("usage") && !line.startsWith("-"))
    .flatMap((line) => [
      ...findMatches(line, /\bclaude-[\w.-]+\b/gu),
      ...line.split(/[\s,|]+/u).filter((part) => CLAUDE_ALIASES.includes(part)),
    ]);

const listClaudeModels = async (): Promise<ReadonlyArray<string>> => {
  for (const args of [["models"], ["--list-models"]]) {
    const lines = await listLines({ executable: "claude", args });
    const listing = lines.join("\n");

    const isLoggedOut = containsAny(listing, CLAUDE_LOGGED_OUT_MARKERS);
    if (isLoggedOut) {
      return CLAUDE_FALLBACK;
    }

    const tokens = claudeModelTokens(lines);

    const hasTokens = tokens.length > 0;
    if (hasTokens) {
      return dedupe(tokens);
    }
  }

  return CLAUDE_FALLBACK;
};

// agy prints IDs glued to their Title Case label: "gemini-3.6-flash-highGemini 3.6 Flash (High)".
const unglueLabel = (label: string): string => (label.split(/(?<=[a-z0-9])(?=[A-Z][a-z])/u)[0] ?? "").trim();

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
const listAgyModels = async (cli: { readonly name: string; readonly path: string }): Promise<ReadonlyArray<string>> => {
  const isNotAgy = cli.name !== "agy";
  if (isNotAgy) {
    return [];
  }

  const agyLines = await listLines({ executable: cli.path, args: ["models"] });
  return agyModelTokens(agyLines);
};

// Models of the CLI refine runs (gemini before agy): agy's list also holds Claude and GPT IDs that gemini rejects.
const listGeminiModels = async (): Promise<ReadonlyArray<string>> => {
  const cli = findFirstCli(["gemini", "agy"]);

  const isNoCliInstalled = cli === null;
  if (isNoCliInstalled) {
    return GEMINI_FALLBACK;
  }

  const agyModels = await listAgyModels(cli);

  const hasAgyModels = agyModels.length > 0;
  if (hasAgyModels) {
    return topModels(agyModels);
  }

  const help = await helpLines(cli.path);
  const helpModels = help.flatMap((line) => findMatches(line, /gemini-[\w.-]+/gu).map(unglueLabel));

  const isHelpEmpty = helpModels.length === 0;
  if (isHelpEmpty) {
    return GEMINI_FALLBACK;
  }

  return topModels(helpModels);
};

const GROK_FALLBACK = ["grok-4.5", "grok-4", "grok-3", "grok-3-mini"];
const GROK_MODEL = /\bgrok-[\w.-]+\b/gu;

const grokListedModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const headingIndex = lines.findIndex((line) => line.toLowerCase().includes("available model"));

  const isHeadingMissing = headingIndex < 0;
  if (isHeadingMissing) {
    return [];
  }

  return lines
    .slice(headingIndex + 1)
    .map((line) => line.replace(/^[\s*•-]+/u, ""))
    .map(bareWord)
    .filter((token) => token.startsWith("grok-"));
};

const grokMentionedModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.flatMap((line) => findMatches(line, GROK_MODEL));

const grokModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const listed = grokListedModels(lines);
  const mentioned = grokMentionedModels(lines);
  return dedupe([...listed, ...mentioned]);
};

const listGrokLines = async (): Promise<ReadonlyArray<string>> => {
  const grokLines = await listLines({ executable: "grok", args: ["models"] });

  const hasGrokLines = grokLines.length > 0;
  if (hasGrokLines) {
    return grokLines;
  }

  return listLines({ executable: "agent", args: ["models"] });
};

const listGrokModels = async (): Promise<ReadonlyArray<string>> => {
  const lines = await listGrokLines();
  const tokens = grokModelTokens(lines);

  const hasTokens = tokens.length > 0;
  if (hasTokens) {
    return tokens;
  }

  const help = await helpLines("grok");
  const helpModels = dedupe(grokMentionedModels(help));

  const isHelpEmpty = helpModels.length === 0;
  if (isHelpEmpty) {
    return GROK_FALLBACK;
  }

  return helpModels;
};

const opencodeLineModels = (line: string): ReadonlyArray<string> => {
  const isModelLine = /^[\w.-]+\/[\w.-]+$/u.test(line);
  if (isModelLine) {
    return [line];
  }

  return findMatches(line, /[\w.-]+\/[\w.-]+/gu).filter((token) => !token.includes("http"));
};

const opencodeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => !/^(?:usage|error|options)/iu.test(line)).flatMap(opencodeLineModels);

const listOpencodeModels = async (): Promise<ReadonlyArray<string>> => {
  for (const args of [["models"], ["model", "list"]]) {
    const lines = await listLines({ executable: "opencode", args });
    const found = opencodeModelTokens(lines);

    const hasFound = found.length > 0;
    if (hasFound) {
      return topModels(found);
    }
  }

  return [];
};

// OAuth providers (codex, copilot) usually work; OpenRouter often needs credits.
const PI_PREFERRED_PREFIXES = ["openai-codex/", "github-copilot/", "kimi"];
const PI_TABLE_COLUMNS = ["context", "max-out", "thinking", "images"];
const PI_HINT_MARKERS = ["login", "api key", "providers.md", "models.md"];
const PI_LOGGED_OUT_MARKERS = ["no models available", "no api key", "use /login", "not logged in"];

const piRank = (token: string): number => {
  const lowercase = token.toLowerCase();

  const isOpenrouterInLowercase = lowercase.includes("openrouter");
  if (isOpenrouterInLowercase) {
    return 9;
  }

  const rank = PI_PREFERRED_PREFIXES.findIndex((prefix) => lowercase.startsWith(prefix));

  const isUnranked = rank < 0;
  if (isUnranked) {
    return 5;
  }

  return rank;
};

const byPiRank = (left: string, right: string): number => piRank(left) - piRank(right) || left.localeCompare(right);

const piLineModels = (line: string): ReadonlyArray<string> => {
  const slashTokens = findMatches(line, /\b[a-z][\w.-]*\/[\w.:-]+\b/giu).filter(
    (token) => !token.toLowerCase().includes("http"),
  );

  const hasSlashTokens = slashTokens.length > 0;
  if (hasSlashTokens) {
    return slashTokens;
  }

  const [provider = "", model = ""] = line.split(/\s+/u);

  const isNotModelRow =
    model === "" ||
    provider.startsWith("-") ||
    PI_TABLE_COLUMNS.includes(model) ||
    model.toLowerCase().includes("http");
  if (isNotModelRow) {
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

  const isRankedEmpty = ranked.length <= 0;
  if (isRankedEmpty) {
    return ["default"];
  }

  return ranked.slice(0, MAX_LISTED_MODELS);
};

const piExecutable = (): string => findFirstCli(["pi", "pie"])?.path ?? "pi";

// provider/model IDs from the `pi --list-models` table ("openai-codex  gpt-5.4-mini  272K ..."), from pi or pie.
const listPiModels = async (): Promise<ReadonlyArray<string>> => {
  const executable = piExecutable();
  const piLines = await listLines({ executable, args: ["--list-models"] });
  return rankPiModels(piLines);
};

interface ProviderSpec {
  readonly id: ProviderId;
  readonly binaries: ReadonlyArray<string>;
  readonly effort: boolean;
  readonly listModels: () => Promise<ReadonlyArray<string>>;
}

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

export interface DiscoveredProvider {
  readonly id: ProviderId;
  readonly binary: string;
  readonly path: string;
  readonly effort: boolean;
  readonly models: ReadonlyArray<string>;
}

const findProviderSpec = (provider: ProviderId): ProviderSpec | null =>
  PROVIDERS.find((candidate) => candidate.id === provider) ?? null;

export const isProviderInstalled = (provider: ProviderId): boolean => {
  const spec = findProviderSpec(provider);

  const isUnknownProvider = spec === null;
  if (isUnknownProvider) {
    return false;
  }

  const cli = findFirstCli(spec.binaries);
  return cli !== null;
};

export const providerModels = async (provider: ProviderId): Promise<ReadonlyArray<string>> => {
  const spec = findProviderSpec(provider);

  const isUnknownProvider = spec === null;
  if (isUnknownProvider) {
    return [];
  }

  return spec.listModels();
};

const withDefaultModel = (models: ReadonlyArray<string>): ReadonlyArray<string> => {
  const hasNoModels = models.length === 0;
  if (hasNoModels) {
    return ["default"];
  }

  return models;
};

const describeProvider = async (spec: ProviderSpec): Promise<DiscoveredProvider | null> => {
  const cli = findFirstCli(spec.binaries);

  const isNotInstalled = cli === null;
  if (isNotInstalled) {
    return null;
  }

  const models = await spec.listModels();
  return {
    id: spec.id,
    binary: cli.name,
    path: cli.path,
    effort: spec.effort,
    models: withDefaultModel(models),
  };
};

const DISCOVERY_CACHE_MS = 120_000;

// Starts stale (at 0), so the first call always lists.
const discoveryCache: { at: number; providers: ReadonlyArray<DiscoveredProvider> } = { at: 0, providers: [] };

// Listed in parallel and remembered for two minutes.
export const discoverProviders = async (request: {
  readonly refresh: boolean;
}): Promise<ReadonlyArray<DiscoveredProvider>> => {
  const age = Date.now() - discoveryCache.at;

  const isFresh = !request.refresh && age < DISCOVERY_CACHE_MS;
  if (isFresh) {
    return discoveryCache.providers;
  }

  const described = await Promise.all(PROVIDERS.map(describeProvider));
  const providers = described.filter((provider): provider is DiscoveredProvider => provider !== null);
  discoveryCache.at = Date.now();
  discoveryCache.providers = providers;
  return providers;
};
