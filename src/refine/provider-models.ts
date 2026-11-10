import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { readDocumentFile, readFileIfReadable } from "#src/storage/state-files.js";
import { containsAny, dedupe, findFirstCli, listNonBlankLines, runCliLines } from "./agent-cli.js";
import { readCodexLastGoodModel } from "./refine-choices.js";

const PIE_EXECUTABLE_NAME = "pie";

const DEFAULT_MODEL_NAME = "default";

const HTTP_MARKER = "http";

const AGENT_EXECUTABLE = "agent";

const AGY_PROVIDER_ID = "agy";

const NOT_LOGGED_IN_PHRASE = "not logged in";

const NEWLINE = "\n";

const LIST_MODELS_FLAG = "--list-models";

const MODELS_COMMAND = "models";

const DASH_PREFIX = "-";

const HAIKU_MODEL_ALIAS = "haiku";

const OPUS_MODEL_ALIAS = "opus";

const SONNET_MODEL_ALIAS = "sonnet";

const KEY_PAIR_SEPARATOR = "=";

const MODEL_WORD = "model";

const LIST_WORD = "list";

const GPT_4_1_MINI_MODEL_ID = "gpt-4.1-mini";

const O4_MINI_MODEL_ID = "o4-mini";

const GPT_5_1_CODEX_MINI_MODEL_ID = "gpt-5.1-codex-mini";

const GPT_5_6_TERRA_MODEL_ID = "gpt-5.6-terra";

const GPT_5_4_MINI_MODEL_ID = "gpt-5.4-mini";

const CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";

const PI_PROVIDER_ID = "pi";

const OPENCODE_PROVIDER_ID = "opencode";

const OLLAMA_PROVIDER_ID = "ollama";

const GROK_PROVIDER_ID = "grok";

const GEMINI_PROVIDER_ID = "gemini";

const CLAUDE_PROVIDER_ID = "claude";

const CODEX_PROVIDER_ID = "codex";

export const providerIdSchema = z.enum([
  CODEX_PROVIDER_ID,
  CLAUDE_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  GROK_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  OPENCODE_PROVIDER_ID,
  PI_PROVIDER_ID,
]);

export type ProviderId = z.infer<typeof providerIdSchema>;

// Tried in order when the requested Codex model is missing or not allowed for this account; fast first.
export const CODEX_MODEL_FALLBACKS = [
  CODEX_SPARK_MODEL_ID,
  GPT_5_4_MINI_MODEL_ID,
  GPT_5_6_TERRA_MODEL_ID,
  GPT_5_1_CODEX_MINI_MODEL_ID,
  O4_MINI_MODEL_ID,
  GPT_4_1_MINI_MODEL_ID,
];

// Offered by the picker after the live ~/.codex/models_cache.json entries.
export const CODEX_PICKER_MODELS = [
  "gpt-5.6-luna",
  GPT_5_6_TERRA_MODEL_ID,
  "gpt-5.5",
  GPT_5_4_MINI_MODEL_ID,
  "gpt-5.4",
  CODEX_SPARK_MODEL_ID,
  GPT_5_1_CODEX_MINI_MODEL_ID,
  O4_MINI_MODEL_ID,
  GPT_4_1_MINI_MODEL_ID,
  "gpt-4.1",
];

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

// Short timeouts so discovery never hangs on a slow CLI; listings run in parallel.
const LISTING_TIMEOUT_MS = 12_000;
const HELP_TIMEOUT_MS = 5_000;
const MAX_LISTED_MODELS = 80;

// A listing has no caller to cancel it, so its own timeout is its signal.
const listLines = (request: { readonly executable: string; readonly args: ReadonlyArray<string> }) =>
  runCliLines({
    ...request,
    timeoutMs: LISTING_TIMEOUT_MS,
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
  });

const listHelpLines = (executable: string) =>
  runCliLines({
    executable,
    args: ["--help"],
    timeoutMs: HELP_TIMEOUT_MS,
    signal: AbortSignal.timeout(HELP_TIMEOUT_MS),
  });

const findPatternTokens = (line: string, pattern: RegExp): ReadonlyArray<string> => line.match(pattern) ?? [];

const readFirstWord = (line: string): string => line.split(/\s+/u)[0] ?? "";

const readBareWord = (token: string): string => readFirstWord(token).replace(/^[()[\],]+|[()[\],]+$/gu, "");

const listTopModels = (tokens: ReadonlyArray<string>): ReadonlyArray<string> =>
  dedupe(tokens).slice(0, MAX_LISTED_MODELS);

const readCodexFile = (name: string): string => {
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

const isVisibleModel = (model: CodexCachedModel): boolean => {
  const visibility = (model.visibility || LIST_WORD).trim().toLowerCase();
  return !["hide", "hidden", "never"].includes(visibility);
};

const readModelSlug = (model: CodexCachedModel): string => (model.slug || model.id || "").trim();

export const listCodexCachedModels = (): ReadonlyArray<string> => {
  const modelsCachePath = readCodexFile("models_cache.json");
  const modelsCache = readDocumentFile({ path: modelsCachePath, schema: codexModelsCacheSchema });

  const isCacheMissing = modelsCache == null;
  if (isCacheMissing) {
    return [];
  }

  return modelsCache.models
    .filter(isVisibleModel)
    .map(readModelSlug)
    .filter((slug) => slug !== "");
};

const isModelSetting = (line: string): boolean =>
  line.startsWith(MODEL_WORD) && !line.startsWith("model_") && line.includes(KEY_PAIR_SEPARATOR);

const listCodexConfiguredModel = (): ReadonlyArray<string> => {
  const codexTomlPath = readCodexFile("config.toml");
  const settingsToml = readFileIfReadable(codexTomlPath) ?? "";
  const modelLine = listNonBlankLines(settingsToml).find(isModelSetting);
  const model = (modelLine || "")
    .split(KEY_PAIR_SEPARATOR)
    .slice(1)
    .join(KEY_PAIR_SEPARATOR)
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
    ...listCodexConfiguredModel(),
    ...listCodexCachedModels(),
    readCodexLastGoodModel(),
    ...CODEX_PICKER_MODELS,
    ...CODEX_MODEL_FALLBACKS,
  ]);

const listOllamaModelNames = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .slice(1)
    .map(readFirstWord)
    .filter((name) => name !== "" && name.toUpperCase() !== "NAME");

const listOllamaModels = async (): Promise<ReadonlyArray<string>> => {
  const ollamaListLines = await listLines({ executable: OLLAMA_PROVIDER_ID, args: [LIST_WORD] });
  return listOllamaModelNames(ollamaListLines);
};

const CLAUDE_FALLBACK = [
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-haiku-4-5",
  SONNET_MODEL_ALIAS,
  OPUS_MODEL_ALIAS,
  HAIKU_MODEL_ALIAS,
];

const listClaudeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !line.toLowerCase().startsWith("usage") && !line.startsWith(DASH_PREFIX))
    .flatMap((line) => [
      ...findPatternTokens(line, /\bclaude-[\w.-]+\b/gu),
      ...line
        .split(/[\s,|]+/u)
        .filter((part) => [SONNET_MODEL_ALIAS, OPUS_MODEL_ALIAS, HAIKU_MODEL_ALIAS].includes(part)),
    ]);

const listClaudeModels = async (): Promise<ReadonlyArray<string>> => {
  for (const argumentList of [[MODELS_COMMAND], [LIST_MODELS_FLAG]]) {
    const lines = await listLines({ executable: CLAUDE_PROVIDER_ID, args: argumentList });
    const listing = lines.join(NEWLINE);

    const isLoggedOut = containsAny(listing, [NOT_LOGGED_IN_PHRASE, "please run /login", "please login"]);
    if (isLoggedOut) {
      return CLAUDE_FALLBACK;
    }

    const tokens = listClaudeModelTokens(lines);

    const hasTokens = tokens.length > 0;
    if (hasTokens) {
      return dedupe(tokens);
    }
  }

  return CLAUDE_FALLBACK;
};

// agy prints IDs glued to their Title Case label: "gemini-3.6-flash-highGemini 3.6 Flash (High)".
const readUnglueLabel = (label: string): string => (label.split(/(?<=[a-z0-9])(?=[A-Z][a-z])/u)[0] ?? "").trim();

const GEMINI_FALLBACK = [
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

const listAgyModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !/^(?:usage|fetching|error|options)/iu.test(line))
    .map(readUnglueLabel)
    .map(readBareWord)
    .filter((token) => /^(?:gemini-|claude-|gpt-)/u.test(token));

// Only agy has a models command; gemini names its models in its help text.
const listAgyModels = async (cli: { readonly name: string; readonly path: string }): Promise<ReadonlyArray<string>> => {
  const isNotAgy = cli.name !== AGY_PROVIDER_ID;
  if (isNotAgy) {
    return [];
  }

  const agyLines = await listLines({ executable: cli.path, args: [MODELS_COMMAND] });
  return listAgyModelTokens(agyLines);
};

// Models of the CLI refine runs (gemini before agy): agy's list also holds Claude and GPT IDs that gemini rejects.
const listGeminiModels = async (): Promise<ReadonlyArray<string>> => {
  const cli = findFirstCli([GEMINI_PROVIDER_ID, AGY_PROVIDER_ID]);

  const isNoCliInstalled = cli == null;
  if (isNoCliInstalled) {
    return GEMINI_FALLBACK;
  }

  const agyModels = await listAgyModels(cli);

  const hasAgyModels = agyModels.length > 0;
  if (hasAgyModels) {
    return listTopModels(agyModels);
  }

  const help = await listHelpLines(cli.path);
  const helpModels = help.flatMap((line) => findPatternTokens(line, /gemini-[\w.-]+/gu).map(readUnglueLabel));

  const isHelpEmpty = helpModels.length === 0;
  if (isHelpEmpty) {
    return GEMINI_FALLBACK;
  }

  return listTopModels(helpModels);
};

const listGrokListedModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const headingIndex = lines.findIndex((line) => line.toLowerCase().includes("available model"));

  const isHeadingMissing = headingIndex < 0;
  if (isHeadingMissing) {
    return [];
  }

  return lines
    .slice(headingIndex + 1)
    .map((line) => line.replace(/^[\s*•-]+/u, ""))
    .map(readBareWord)
    .filter((token) => token.startsWith("grok-"));
};

const listGrokMentionedModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.flatMap((line) => findPatternTokens(line, /\bgrok-[\w.-]+\b/gu));

const listGrokModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const listed = listGrokListedModels(lines);
  const mentioned = listGrokMentionedModels(lines);
  return dedupe([...listed, ...mentioned]);
};

const listGrokLines = async (): Promise<ReadonlyArray<string>> => {
  const grokLines = await listLines({ executable: GROK_PROVIDER_ID, args: [MODELS_COMMAND] });

  const hasGrokLines = grokLines.length > 0;
  if (hasGrokLines) {
    return grokLines;
  }

  return listLines({ executable: AGENT_EXECUTABLE, args: [MODELS_COMMAND] });
};

const listGrokModels = async (): Promise<ReadonlyArray<string>> => {
  const lines = await listGrokLines();
  const tokens = listGrokModelTokens(lines);

  const hasTokens = tokens.length > 0;
  if (hasTokens) {
    return tokens;
  }

  const help = await listHelpLines(GROK_PROVIDER_ID);
  const grokMentionedModels = listGrokMentionedModels(help);
  const helpModels = dedupe(grokMentionedModels);

  const isHelpEmpty = helpModels.length === 0;
  if (isHelpEmpty) {
    return ["grok-4.5", "grok-4", "grok-3", "grok-3-mini"];
  }

  return helpModels;
};

const listOpencodeLineModels = (line: string): ReadonlyArray<string> => {
  const isModelLine = /^[\w.-]+\/[\w.-]+$/u.test(line);
  if (isModelLine) {
    return [line];
  }

  return findPatternTokens(line, /[\w.-]+\/[\w.-]+/gu).filter((token) => !token.includes(HTTP_MARKER));
};

const listOpencodeModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => !/^(?:usage|error|options)/iu.test(line)).flatMap(listOpencodeLineModels);

const listOpencodeModels = async (): Promise<ReadonlyArray<string>> => {
  for (const argumentList of [[MODELS_COMMAND], [MODEL_WORD, LIST_WORD]]) {
    const lines = await listLines({ executable: OPENCODE_PROVIDER_ID, args: argumentList });
    const found = listOpencodeModelTokens(lines);

    const hasFound = found.length > 0;
    if (hasFound) {
      return listTopModels(found);
    }
  }

  return [];
};

const readPiRank = (token: string): number => {
  const lowercase = token.toLowerCase();

  const isOpenrouterInLowercase = lowercase.includes("openrouter");
  if (isOpenrouterInLowercase) {
    const openrouterRank = 9;

    return openrouterRank;
  }

  // OAuth providers (codex, copilot) usually work; OpenRouter often needs credits.
  const rank = ["openai-codex/", "github-copilot/", "kimi"].findIndex((prefix) => lowercase.startsWith(prefix));

  const isUnranked = rank < 0;
  if (isUnranked) {
    const unrankedRank = 5;

    return unrankedRank;
  }

  return rank;
};

const readByPiRank = (left: string, right: string): number =>
  readPiRank(left) - readPiRank(right) || left.localeCompare(right);

const listPiLineModels = (line: string): ReadonlyArray<string> => {
  const slashTokens = findPatternTokens(line, /\b[a-z][\w.-]*\/[\w.:-]+\b/giu).filter(
    (token) => !token.toLowerCase().includes(HTTP_MARKER),
  );

  const hasSlashTokens = slashTokens.length > 0;
  if (hasSlashTokens) {
    return slashTokens;
  }

  const [provider = "", model = ""] = line.split(/\s+/u);

  const isNotModelLine =
    model === "" ||
    provider.startsWith(DASH_PREFIX) ||
    ["context", "max-out", "thinking", "images"].includes(model) ||
    model.toLowerCase().includes(HTTP_MARKER);
  if (isNotModelLine) {
    return [];
  }

  return [`${provider}/${model}`];
};

const listPiModelTokens = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines
    .filter((line) => !/^(?:usage|options|commands|pi |use |see:|error|provider)/iu.test(line))
    .filter((line) => !containsAny(line, ["login", "api key", "providers.md", "models.md"]))
    .flatMap(listPiLineModels);

const rankPiModels = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const listing = lines.join(NEWLINE);

  const isLoggedOut = containsAny(listing, ["no models available", "no api key", "use /login", NOT_LOGGED_IN_PHRASE]);
  if (isLoggedOut) {
    return [DEFAULT_MODEL_NAME];
  }

  const tokens = listPiModelTokens(lines);
  const uniqueTokens = dedupe(tokens);
  const ranked = [...uniqueTokens].sort(readByPiRank);

  const isRankedEmpty = ranked.length <= 0;
  if (isRankedEmpty) {
    return [DEFAULT_MODEL_NAME];
  }

  return ranked.slice(0, MAX_LISTED_MODELS);
};

const readPiExecutable = (): string => findFirstCli([PI_PROVIDER_ID, PIE_EXECUTABLE_NAME])?.path ?? PI_PROVIDER_ID;

// provider/model IDs from the `pi --list-models` table ("openai-codex  gpt-5.4-mini  272K ..."), from pi or pie.
const listPiModels = async (): Promise<ReadonlyArray<string>> => {
  const executable = readPiExecutable();
  const piLines = await listLines({ executable, args: [LIST_MODELS_FLAG] });
  return rankPiModels(piLines);
};

interface ProviderSpec {
  readonly id: ProviderId;
  readonly binaries: ReadonlyArray<string>;
  readonly effort: boolean;
  readonly listModels: () => Promise<ReadonlyArray<string>>;
}

const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  { id: CODEX_PROVIDER_ID, binaries: [CODEX_PROVIDER_ID], effort: true, listModels: listCodexModels },
  { id: CLAUDE_PROVIDER_ID, binaries: [CLAUDE_PROVIDER_ID], effort: false, listModels: listClaudeModels },
  {
    id: GEMINI_PROVIDER_ID,
    binaries: [GEMINI_PROVIDER_ID, AGY_PROVIDER_ID],
    effort: true,
    listModels: listGeminiModels,
  },
  { id: GROK_PROVIDER_ID, binaries: [GROK_PROVIDER_ID, AGENT_EXECUTABLE], effort: true, listModels: listGrokModels },
  { id: OLLAMA_PROVIDER_ID, binaries: [OLLAMA_PROVIDER_ID], effort: false, listModels: listOllamaModels },
  { id: OPENCODE_PROVIDER_ID, binaries: [OPENCODE_PROVIDER_ID], effort: true, listModels: listOpencodeModels },
  { id: PI_PROVIDER_ID, binaries: [PI_PROVIDER_ID, PIE_EXECUTABLE_NAME], effort: true, listModels: listPiModels },
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

  const isUnknownProvider = spec == null;
  if (isUnknownProvider) {
    return false;
  }

  const cli = findFirstCli(spec.binaries);
  return cli != null;
};

export const listProviderModels = async (provider: ProviderId): Promise<ReadonlyArray<string>> => {
  const spec = findProviderSpec(provider);

  const isUnknownProvider = spec == null;
  if (isUnknownProvider) {
    return [];
  }

  return spec.listModels();
};

const readModelsOrDefault = (models: ReadonlyArray<string>): ReadonlyArray<string> => {
  const hasNoModels = models.length === 0;
  if (hasNoModels) {
    return [DEFAULT_MODEL_NAME];
  }

  return models;
};

const describeProvider = async (spec: ProviderSpec): Promise<DiscoveredProvider | null> => {
  const cli = findFirstCli(spec.binaries);

  const isNotInstalled = cli == null;
  if (isNotInstalled) {
    return null;
  }

  const models = await spec.listModels();
  return {
    id: spec.id,
    binary: cli.name,
    path: cli.path,
    effort: spec.effort,
    models: readModelsOrDefault(models),
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

  const providerDescriptions = PROVIDERS.map(describeProvider);
  const described = await Promise.all(providerDescriptions);
  const providers = described.filter((provider): provider is DiscoveredProvider => provider != null);
  discoveryCache.at = Date.now();
  discoveryCache.providers = providers;
  return providers;
};
