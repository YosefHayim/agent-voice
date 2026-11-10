import { describeError } from "#src/error-message.js";
import type { Settings } from "#src/settings/config-schema.js";
import { containsAny, dedupe } from "./agent-cli.js";
import { CODEX_MODEL_FALLBACKS, isProviderInstalled, listProviderModels, type ProviderId } from "./provider-models.js";
import {
  DEFAULT_REFINE_EFFORT,
  DEFAULT_REFINE_MODEL,
  markCodexModelFailed,
  readCodexFailedModels,
  readCodexLastGoodModel,
  readSavedChoice,
  type SavedChoice,
  saveRefineChoice,
} from "./refine-choices.js";
import { isPickerEnabled, pickRefineTargetWithDialogs, SKIP_REFINE_LABEL } from "./refine-picker.js";
import { readNamedModel, refineWithProvider } from "./refine-providers.js";
import { isFailedModelReply, isModelUnavailableError } from "./refine-reply.js";

const REFINED_STATUS = "refined";

const AUTO_CHOICE = "auto";

const FAILED_STATUS = "failed";

const DEFAULT_MODEL_NAME = "default";

const CODEX_PROVIDER_ID = "codex";

// Bounds so a dictation release never hangs on rotation.
const MAX_MODELS_PER_PROVIDER = 6;
const MAX_CROSS_PROVIDER_ATTEMPTS = 4;
const MAX_TOTAL_ATTEMPTS = 12;

const FALLBACK_ORDER: ReadonlyArray<ProviderId> = [
  CODEX_PROVIDER_ID,
  "opencode",
  "gemini",
  "grok",
  "pi",
  "ollama",
  "claude",
];

const LAST_RESORT_MODEL: Readonly<Record<ProviderId, string>> = {
  codex: DEFAULT_REFINE_MODEL,
  ollama: "llama3.2",
  grok: "grok-4.5",
  claude: "sonnet",
  gemini: "gemini-3.6-flash-low",
  opencode: "opencode/big-pickle",
  pi: DEFAULT_MODEL_NAME,
};

// Generic failures (network, CLI errors) still move on to the next candidate.
export const canRotate = (detail: string): boolean =>
  isFailedModelReply(detail) ||
  containsAny(detail, [FAILED_STATUS, "error", "timeout", "timed out", "connection", "refused", "not found", "empty"]);

// Models that already failed for this account go last, so a ChatGPT-account rejection (~3 s) is not paid every time.
export const listCodexModelCandidates = (request: {
  readonly preferred: string;
  readonly lastGood: string;
  readonly failed: ReadonlySet<string>;
}): ReadonlyArray<string> => {
  const preferred = request.preferred.trim() || DEFAULT_REFINE_MODEL;
  const isLastGoodUsable = request.lastGood !== "" && !request.failed.has(request.lastGood);
  const ordered = dedupe([preferred, request.lastGood, ...CODEX_MODEL_FALLBACKS]);
  // A failed preferred model still goes first when no last-good model can stand in for it.
  const isDeferred = (model: string): boolean => request.failed.has(model) && (model !== preferred || isLastGoodUsable);
  const usable = ordered.filter((model) => !isDeferred(model));
  const deferred = ordered.filter(isDeferred);
  return [...usable, ...deferred];
};

const pickSavedModel = (saved: SavedChoice | null, provider: ProviderId): string => {
  const isSavedMissing = saved == null;
  if (isSavedMissing) {
    return "";
  }

  const isNotSavedForProvider = saved.provider !== provider;
  if (isNotSavedForProvider) {
    return "";
  }

  return saved.model;
};

const listDiscoveredModels = async (provider: ProviderId, preferred: string): Promise<ReadonlyArray<string>> => {
  const isCodex = provider === CODEX_PROVIDER_ID;

  const isNotCodex = !isCodex;
  if (isNotCodex) {
    return listProviderModels(provider);
  }

  const lastGood = readCodexLastGoodModel();
  const failed = readCodexFailedModels();
  return listCodexModelCandidates({ preferred, lastGood, failed });
};

const listModelCandidates = async (provider: ProviderId, preferred: string): Promise<ReadonlyArray<string>> => {
  const chosenModel = readNamedModel(preferred, [DEFAULT_MODEL_NAME, AUTO_CHOICE]);
  const saved = readSavedChoice();
  const savedModel = pickSavedModel(saved, provider);
  const discovered = await listDiscoveredModels(provider, preferred);
  const candidates = dedupe([chosenModel, savedModel, ...discovered]).slice(0, MAX_MODELS_PER_PROVIDER);

  const hasCandidates = candidates.length > 0;
  if (hasCandidates) {
    return candidates;
  }

  return [LAST_RESORT_MODEL[provider]];
};

interface AttemptTarget {
  readonly provider: ProviderId;
  readonly model: string;
}

const listProviderTargets = async (provider: ProviderId, preferred: string): Promise<ReadonlyArray<AttemptTarget>> => {
  const models = await listModelCandidates(provider, preferred);
  return models.map((model) => ({ provider, model }));
};

const listInstalledProviderTargets = async (
  provider: ProviderId,
  preferred: string,
): Promise<ReadonlyArray<AttemptTarget>> => {
  const isNotInstalled = !isProviderInstalled(provider);
  if (isNotInstalled) {
    return [];
  }

  return listProviderTargets(provider, preferred);
};

// A fallback provider gets one attempt: its first candidate model.
const pickFallbackTarget = async (provider: ProviderId, saved: SavedChoice | null): Promise<AttemptTarget> => {
  const savedModel = pickSavedModel(saved, provider);
  const models = await listModelCandidates(provider, savedModel);
  return { provider, model: models[0] || LAST_RESORT_MODEL[provider] };
};

// The requested model belongs to the saved provider; any other provider starts from its discovered list.
const pickAutoStartModel = (
  provider: ProviderId,
  request: { readonly savedProvider: string; readonly requestedModel: string },
): string => {
  const isNotSavedProvider = provider !== request.savedProvider;
  if (isNotSavedProvider) {
    return "";
  }

  return request.requestedModel;
};

const listAutoAttempts = async (requestedModel: string): Promise<ReadonlyArray<AttemptTarget>> => {
  const saved = readSavedChoice();
  const savedProvider = saved?.provider ?? "";
  const savedFirst = [
    ...FALLBACK_ORDER.filter((provider) => provider === savedProvider),
    ...FALLBACK_ORDER.filter((provider) => provider !== savedProvider),
  ];
  const installed = savedFirst.filter(isProviderInstalled).slice(0, 1 + MAX_CROSS_PROVIDER_ATTEMPTS);
  const [leadProvider, ...fallbackProviders] = installed;

  const hasNoProvider = leadProvider == null;
  if (hasNoProvider) {
    return [];
  }

  const leadModel = pickAutoStartModel(leadProvider, { savedProvider, requestedModel });
  const leadTargets = await listProviderTargets(leadProvider, leadModel);
  const fallbackTargets = await Promise.all(fallbackProviders.map((provider) => pickFallbackTarget(provider, saved)));
  return [...leadTargets, ...fallbackTargets];
};

export const createAttemptQueue = async (request: {
  readonly provider: Settings["refineProvider"];
  readonly model: string;
}): Promise<ReadonlyArray<AttemptTarget>> => {
  const isAutoProvider = request.provider === AUTO_CHOICE;
  if (isAutoProvider) {
    return listAutoAttempts(request.model);
  }

  const preferredProvider = request.provider;
  const ownTargets = await listInstalledProviderTargets(preferredProvider, request.model);
  const saved = readSavedChoice();
  const otherProviders = FALLBACK_ORDER.filter(
    (provider) => provider !== preferredProvider && isProviderInstalled(provider),
  ).slice(0, MAX_CROSS_PROVIDER_ATTEMPTS);
  const fallbackTargets = await Promise.all(otherProviders.map((provider) => pickFallbackTarget(provider, saved)));
  return [...ownTargets, ...fallbackTargets].slice(0, MAX_TOTAL_ATTEMPTS);
};

type RefineRequest = {
  readonly draft: string;
  readonly provider: Settings["refineProvider"];
  readonly model: string;
  readonly effort: string;
  readonly allowPicker: boolean;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
};

const readSavedEffort = (): string => readSavedChoice()?.effort ?? "";

const pickStartingModel = (request: RefineRequest): string => {
  const configuredModel = request.model.trim();

  const isModelChosen = configuredModel !== "" || request.provider === AUTO_CHOICE;
  if (isModelChosen) {
    return configuredModel;
  }

  const savedModel = pickSavedModel(readSavedChoice(), request.provider);

  const hasSavedModel = savedModel !== "";
  if (hasSavedModel) {
    return savedModel;
  }

  const isCodex = request.provider === CODEX_PROVIDER_ID;
  if (isCodex) {
    return DEFAULT_REFINE_MODEL;
  }

  return "";
};

type TargetVerdict =
  | { readonly status: "refined"; readonly refined: string }
  | { readonly status: "failed"; readonly detail: string };

const refineWithTarget = async (
  target: AttemptTarget,
  request: { readonly draft: string; readonly effort: string; readonly signal: AbortSignal },
): Promise<TargetVerdict> => {
  try {
    const refined = await refineWithProvider(
      { ...target, effort: request.effort, draft: request.draft },
      request.signal,
    );
    return { status: REFINED_STATUS, refined };
  } catch (error) {
    return { status: FAILED_STATUS, detail: describeError(error) };
  }
};

interface AttemptsVerdict {
  readonly refined: string | null;
  readonly failures: ReadonlyArray<string>;
}

const tryAttempts = async (
  request: RefineRequest & { readonly attempts: ReadonlyArray<AttemptTarget>; readonly effort: string },
): Promise<AttemptsVerdict> => {
  const failures: Array<string> = [];
  for (const target of request.attempts) {
    request.log(`refine try ${target.provider}/${target.model}`);
    const verdict = await refineWithTarget(target, request);

    const isRefined = verdict.status === REFINED_STATUS;
    if (isRefined) {
      saveRefineChoice({ provider: target.provider, model: target.model, effort: request.effort });
      return { refined: verdict.refined, failures };
    }

    const detail = verdict.detail;
    const failureDetailCharacters = 400;

    failures.push(`${target.provider}/${target.model}: ${detail.slice(0, failureDetailCharacters)}`);

    const isUnavailableCodexModel = target.provider === CODEX_PROVIDER_ID && isModelUnavailableError(detail);
    if (isUnavailableCodexModel) {
      markCodexModelFailed(target.model);
    }

    const isRotationStopped = !canRotate(detail);
    if (isRotationStopped) {
      break;
    }
  }

  return { refined: null, failures };
};

export const refinePrompt = async (request: RefineRequest): Promise<string> => {
  const draft = request.draft.trim();

  const isDraftEmpty = draft === "";
  if (isDraftEmpty) {
    throw new Error("Nothing to refine");
  }

  const effort = request.effort.trim().toLowerCase() || readSavedEffort() || DEFAULT_REFINE_EFFORT;
  const model = pickStartingModel(request);
  const attempts = await createAttemptQueue({ provider: request.provider, model });

  const hasNoAttempts = attempts.length === 0;
  if (hasNoAttempts) {
    throw new Error("No refine provider found on PATH (install codex, claude, grok, ollama, …).");
  }

  const tried = await tryAttempts({ ...request, draft, attempts, effort });
  const refinedPrompt = tried.refined;

  const hasRefined = refinedPrompt != null;
  if (hasRefined) {
    return refinedPrompt;
  }

  const triedFailuresCharacters = 2_000;

  const joined = (tried.failures.join("; ") || "all refine attempts failed").slice(0, triedFailuresCharacters);

  const isNotPickerAllowed = !request.allowPicker || !isPickerEnabled();
  if (isNotPickerAllowed) {
    throw new Error(`refine failed after fallbacks: ${joined}`);
  }

  const fallbackReasonCharacters = 500;

  const picked = await pickRefineTargetWithDialogs({
    reason: `Automatic refine fallbacks failed.\n${joined.slice(0, fallbackReasonCharacters)}`,
    preferredProvider: request.provider,
    preferredModel: request.model,
    preferredEffort: effort,
    offerSkip: true,
  });

  const isPickCancelled = picked == null;
  if (isPickCancelled) {
    throw new Error(`refine cancelled at the picker: ${joined}`);
  }

  const isSkipped = picked.model === SKIP_REFINE_LABEL;
  if (isSkipped) {
    request.log("refine skipped at the picker; keeping the dictated text");
    return draft;
  }

  const pickEffort = picked.effort || effort;
  saveRefineChoice({ ...picked, effort: pickEffort });
  return refineWithProvider({ ...picked, effort: pickEffort, draft }, request.signal);
};
