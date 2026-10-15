import { Effect, Either, Option, Schema } from "effect";

import type { Config } from "../settings/configSchema.js";
import { containsAny, dedupe } from "./agentCli.js";
import { CODEX_MODEL_FALLBACKS, isProviderInstalled, type ProviderId, providerModels } from "./providerModels.js";
import {
  codexFailedModels,
  codexLastGoodModel,
  DEFAULT_REFINE_EFFORT,
  DEFAULT_REFINE_MODEL,
  markCodexModelFailed,
  readSavedChoice,
  type SavedChoice,
  saveRefineChoice,
} from "./refineChoices.js";
import { pickerEnabled, pickRefineTargetWithDialogs, SKIP_REFINE_LABEL } from "./refinePicker.js";
import { namedModel, refineWithProvider } from "./refineProviders.js";
import { isModelUnavailableError, looksLikeFailedModelOutput } from "./refineReply.js";

// Bounds so a dictation release never hangs on rotation.
const MAX_MODELS_PER_PROVIDER = 6;
const MAX_CROSS_PROVIDER_ATTEMPTS = 4;
const MAX_TOTAL_ATTEMPTS = 12;

// The order for trying other providers after the requested one fails.
const FALLBACK_ORDER: ReadonlyArray<ProviderId> = ["codex", "opencode", "gemini", "grok", "pi", "ollama", "claude"];

const LAST_RESORT_MODEL: Readonly<Record<ProviderId, string>> = {
  codex: DEFAULT_REFINE_MODEL,
  ollama: "llama3.2",
  grok: "grok-4.5",
  claude: "sonnet",
  gemini: "gemini-3.6-flash-low",
  opencode: "opencode/big-pickle",
  pi: "default",
};

// Generic failures (network, CLI errors) still move on to the next candidate.
const ROTATE_MARKERS = ["failed", "error", "timeout", "timed out", "connection", "refused", "not found", "empty"];

export const shouldRotate = (detail: string): boolean =>
  looksLikeFailedModelOutput(detail) || containsAny(detail, ROTATE_MARKERS);

// Models that already failed for this account go last, so a ChatGPT-account rejection (~3 s) is not paid every time.
export const codexModelCandidates = (request: {
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

const savedModelFor = (saved: Option.Option<SavedChoice>, provider: ProviderId): string =>
  saved.pipe(
    Option.filter((choice) => choice.provider === provider),
    Option.map((choice) => choice.model),
    Option.getOrElse(() => ""),
  );

const discoveredModels = (provider: ProviderId, preferred: string): Effect.Effect<ReadonlyArray<string>> => {
  if (provider !== "codex") {
    return providerModels(provider);
  }

  const lastGood = codexLastGoodModel();
  const failed = codexFailedModels();
  const candidates = codexModelCandidates({ preferred, lastGood, failed });
  return Effect.succeed(candidates);
};

// The preferred model, the saved pick, then the discovered list.
const modelCandidates = (provider: ProviderId, preferred: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const chosenModel = namedModel(preferred, ["default", "auto"]);
    const saved = readSavedChoice();
    const savedModel = savedModelFor(saved, provider);
    const discovered = yield* discoveredModels(provider, preferred);
    const candidates = dedupe([chosenModel, savedModel, ...discovered]).slice(0, MAX_MODELS_PER_PROVIDER);
    if (candidates.length === 0) {
      return [LAST_RESORT_MODEL[provider]];
    }

    return candidates;
  });

type AttemptTarget = { readonly provider: ProviderId; readonly model: string };

const providerTargets = (provider: ProviderId, preferred: string): Effect.Effect<ReadonlyArray<AttemptTarget>> =>
  modelCandidates(provider, preferred).pipe(Effect.map((models) => models.map((model) => ({ provider, model }))));

const installedProviderTargets = (
  provider: ProviderId,
  preferred: string,
): Effect.Effect<ReadonlyArray<AttemptTarget>> => {
  if (!isProviderInstalled(provider)) {
    return Effect.succeed([]);
  }

  return providerTargets(provider, preferred);
};

// A fallback provider gets one attempt: its first candidate model.
const fallbackTarget = (provider: ProviderId, saved: Option.Option<SavedChoice>): Effect.Effect<AttemptTarget> => {
  const savedModel = savedModelFor(saved, provider);
  return modelCandidates(provider, savedModel).pipe(
    Effect.map((models) => ({ provider, model: models[0] || LAST_RESORT_MODEL[provider] })),
  );
};

// The requested model belongs to the saved provider; any other provider starts from its discovered list.
const autoStartModel = (
  provider: ProviderId,
  request: { readonly savedProvider: string; readonly requestedModel: string },
): string => {
  if (provider !== request.savedProvider) {
    return "";
  }

  return request.requestedModel;
};

const autoAttempts = (requestedModel: string): Effect.Effect<ReadonlyArray<AttemptTarget>> =>
  Effect.gen(function* () {
    const saved = readSavedChoice();
    const savedProvider = saved.pipe(
      Option.map((choice) => choice.provider),
      Option.getOrElse(() => ""),
    );
    const savedFirst = [
      ...FALLBACK_ORDER.filter((provider) => provider === savedProvider),
      ...FALLBACK_ORDER.filter((provider) => provider !== savedProvider),
    ];
    const installed = savedFirst.filter(isProviderInstalled).slice(0, 1 + MAX_CROSS_PROVIDER_ATTEMPTS);
    const [leadProvider, ...fallbackProviders] = installed;
    if (leadProvider === undefined) {
      return [];
    }

    const leadModel = autoStartModel(leadProvider, { savedProvider, requestedModel });
    const leadTargets = yield* providerTargets(leadProvider, leadModel);
    const fallbackTargets = yield* Effect.forEach(fallbackProviders, (provider) => fallbackTarget(provider, saved));
    return [...leadTargets, ...fallbackTargets];
  });

// The preferred provider's models first, then the first model of each other installed provider.
export const attemptQueue = (request: {
  readonly provider: Config["refineProvider"];
  readonly model: string;
}): Effect.Effect<ReadonlyArray<AttemptTarget>> =>
  Effect.gen(function* () {
    if (request.provider === "auto") {
      return yield* autoAttempts(request.model);
    }

    const preferredProvider = request.provider;
    const ownTargets = yield* installedProviderTargets(preferredProvider, request.model);
    const saved = readSavedChoice();
    const otherProviders = FALLBACK_ORDER.filter(
      (provider) => provider !== preferredProvider && isProviderInstalled(provider),
    ).slice(0, MAX_CROSS_PROVIDER_ATTEMPTS);
    const fallbackTargets = yield* Effect.forEach(otherProviders, (provider) => fallbackTarget(provider, saved));
    return [...ownTargets, ...fallbackTargets].slice(0, MAX_TOTAL_ATTEMPTS);
  });

export class RefineFailed extends Schema.TaggedError<RefineFailed>()("RefineFailed", {
  detail: Schema.String,
}) {
  get message(): string {
    return this.detail;
  }
}

type RefineRequest = {
  readonly draft: string;
  readonly provider: Config["refineProvider"];
  readonly model: string;
  readonly effort: string;
  readonly allowPicker: boolean;
  readonly log: (line: string) => void;
};

const savedEffort = (): string =>
  readSavedChoice().pipe(
    Option.map((choice) => choice.effort),
    Option.getOrElse(() => ""),
  );

// The configured model, else the saved pick for this provider, else Codex's default.
const startingModel = (request: RefineRequest): string => {
  const configuredModel = request.model.trim();
  if (configuredModel !== "" || request.provider === "auto") {
    return configuredModel;
  }

  const saved = readSavedChoice();
  const savedModel = savedModelFor(saved, request.provider);
  if (savedModel !== "") {
    return savedModel;
  }

  if (request.provider === "codex") {
    return DEFAULT_REFINE_MODEL;
  }

  return "";
};

const tryAttempts = (
  request: RefineRequest & { readonly attempts: ReadonlyArray<AttemptTarget>; readonly effort: string },
) =>
  Effect.gen(function* () {
    const failures: Array<string> = [];
    for (const target of request.attempts) {
      request.log(`refine try ${target.provider}/${target.model}`);
      const attempt = yield* refineWithProvider({ ...target, effort: request.effort, draft: request.draft }).pipe(
        Effect.either,
      );
      if (Either.isRight(attempt)) {
        saveRefineChoice({ provider: target.provider, model: target.model, effort: request.effort });
        return { refined: Option.some(attempt.right), failures };
      }

      const detail = attempt.left.detail;
      failures.push(`${target.provider}/${target.model}: ${detail.slice(0, 400)}`);
      const isUnavailableCodexModel = target.provider === "codex" && isModelUnavailableError(detail);
      if (isUnavailableCodexModel) {
        markCodexModelFailed(target.model);
      }

      if (!shouldRotate(detail)) {
        break;
      }
    }

    return { refined: Option.none<string>(), failures };
  });

// Refine with rotation; when every attempt fails, the picker (if allowed) can choose a model or skip refine.
export const refinePrompt = (request: RefineRequest): Effect.Effect<string, RefineFailed> =>
  Effect.gen(function* () {
    const draft = request.draft.trim();
    if (draft === "") {
      return yield* new RefineFailed({ detail: "Nothing to refine" });
    }

    const effort = request.effort.trim().toLowerCase() || savedEffort() || DEFAULT_REFINE_EFFORT;
    const model = startingModel(request);
    const attempts = yield* attemptQueue({ provider: request.provider, model });
    if (attempts.length === 0) {
      return yield* new RefineFailed({
        detail: "No refine provider found on PATH (install codex, claude, grok, ollama, …).",
      });
    }

    const tried = yield* tryAttempts({ ...request, draft, attempts, effort });
    if (Option.isSome(tried.refined)) {
      return tried.refined.value;
    }

    const joined = (tried.failures.join("; ") || "all refine attempts failed").slice(0, 2_000);
    const isPickerAllowed = request.allowPicker && pickerEnabled();
    if (!isPickerAllowed) {
      return yield* new RefineFailed({ detail: `refine failed after fallbacks: ${joined}` });
    }

    const picked = yield* pickRefineTargetWithDialogs({
      reason: `Automatic refine fallbacks failed.\n${joined.slice(0, 500)}`,
      preferredProvider: request.provider,
      preferredModel: request.model,
      preferredEffort: effort,
      offerSkip: true,
    });
    if (Option.isNone(picked)) {
      return yield* new RefineFailed({ detail: `refine cancelled at the picker: ${joined}` });
    }

    if (picked.value.model === SKIP_REFINE_LABEL) {
      request.log("refine skipped at the picker; keeping the dictated text");
      return draft;
    }

    const pickEffort = picked.value.effort || effort;
    saveRefineChoice({ ...picked.value, effort: pickEffort });
    return yield* refineWithProvider({ ...picked.value, effort: pickEffort, draft }).pipe(
      Effect.mapError((failure) => new RefineFailed({ detail: failure.message })),
    );
  });
