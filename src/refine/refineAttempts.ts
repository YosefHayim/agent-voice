/**
 * Route-aware refine: try the preferred provider, rotate its models, then other providers on this Mac,
 * and offer the macOS picker when every attempt fails.
 */

import { Effect, Option, Schema } from "effect";

import type { Config } from "../settings/configSchema.js";
import { dedupe } from "./agentCli.js";
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
import { refineWithProvider } from "./refineProviders.js";
import { isModelUnavailableError, looksLikeFailedModelOutput } from "./refineReply.js";

// Bounds so a dictation release never hangs on rotation.
const MAX_MODELS_PER_PROVIDER = 6;
const MAX_CROSS_PROVIDER_ATTEMPTS = 4;
const MAX_TOTAL_ATTEMPTS = 12;

/** Order for trying other providers after the requested one fails. */
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
  looksLikeFailedModelOutput(detail) || ROTATE_MARKERS.some((marker) => detail.toLowerCase().includes(marker));

/**
 * Codex try order: the preferred model, the last model that worked, then the fallbacks. Models that
 * already failed for this account go last, so a ChatGPT-account rejection (~3 s) is not paid every time.
 */
export const codexModelCandidates = (request: {
  readonly preferred: string;
  readonly lastGood: string;
  readonly failed: ReadonlySet<string>;
}): ReadonlyArray<string> => {
  const preferred = request.preferred.trim() || DEFAULT_REFINE_MODEL;
  const lastGoodUsable = request.lastGood !== "" && !request.failed.has(request.lastGood);
  const head =
    request.failed.has(preferred) && lastGoodUsable ? [request.lastGood, preferred] : [preferred, request.lastGood];
  const ordered = dedupe([...head, ...CODEX_MODEL_FALLBACKS]);
  const deferred = ordered.filter((name) => request.failed.has(name) && (name !== preferred || lastGoodUsable));
  return [...ordered.filter((name) => !deferred.includes(name)), ...deferred];
};

const savedModelFor = (saved: Option.Option<SavedChoice>, provider: ProviderId): string =>
  Option.getOrElse(
    Option.map(
      Option.filter(saved, (choice) => choice.provider === provider),
      (choice) => choice.model,
    ),
    () => "",
  );

/** Model IDs for one provider: the preferred one, the saved pick, then the discovered list. */
const modelCandidates = (provider: ProviderId, preferred: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const head = ["", "default", "auto"].includes(preferred.trim()) ? [] : [preferred.trim()];
    const saved = savedModelFor(readSavedChoice(), provider);
    const discovered =
      provider === "codex"
        ? codexModelCandidates({ preferred, lastGood: codexLastGoodModel(), failed: codexFailedModels() })
        : yield* providerModels(provider);
    const candidates = dedupe([...head, saved, ...discovered]).slice(0, MAX_MODELS_PER_PROVIDER);
    return candidates.length > 0 ? candidates : [LAST_RESORT_MODEL[provider]];
  });

type AttemptTarget = { readonly provider: ProviderId; readonly model: string };

const autoAttempts = (preferredModel: string): Effect.Effect<ReadonlyArray<AttemptTarget>> =>
  Effect.gen(function* () {
    const saved = readSavedChoice();
    const savedProvider = Option.getOrElse(
      Option.map(saved, (choice) => choice.provider),
      () => "",
    );
    const order = [
      ...FALLBACK_ORDER.filter((provider) => provider === savedProvider),
      ...FALLBACK_ORDER.filter((provider) => provider !== savedProvider),
    ].filter(isProviderInstalled);
    // The first provider gets its model list; each fallback provider one model, as in the non-auto queue.
    const attempts: Array<AttemptTarget> = [];
    for (const [index, provider] of order.slice(0, 1 + MAX_CROSS_PROVIDER_ATTEMPTS).entries()) {
      const preferred = provider === savedProvider ? preferredModel : savedModelFor(saved, provider);
      const models = yield* modelCandidates(provider, preferred);
      attempts.push(...(index === 0 ? models : models.slice(0, 1)).map((model) => ({ provider, model })));
    }
    return attempts;
  });

/** (provider, model) attempts: the preferred provider's models first, then the first model of other installed providers. */
export const attemptQueue = (request: {
  readonly provider: Config["refineProvider"];
  readonly model: string;
}): Effect.Effect<ReadonlyArray<AttemptTarget>> =>
  Effect.gen(function* () {
    if (request.provider === "auto") {
      return yield* autoAttempts(request.model);
    }

    const preferredProvider = request.provider;
    const own = isProviderInstalled(preferredProvider)
      ? (yield* modelCandidates(preferredProvider, request.model)).map((model) => ({
          provider: preferredProvider,
          model,
        }))
      : [];
    const saved = readSavedChoice();
    const others = FALLBACK_ORDER.filter(
      (provider) => provider !== preferredProvider && isProviderInstalled(provider),
    ).slice(0, MAX_CROSS_PROVIDER_ATTEMPTS);
    const cross = yield* Effect.forEach(others, (provider) =>
      Effect.map(modelCandidates(provider, savedModelFor(saved, provider)), (models) => ({
        provider,
        model: models[0] || LAST_RESORT_MODEL[provider],
      })),
    );
    return [...own, ...cross].slice(0, MAX_TOTAL_ATTEMPTS);
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
  Option.getOrElse(
    Option.map(readSavedChoice(), (choice) => choice.effort),
    () => "",
  );

/** The model to start with: the configured one, else the saved pick for this provider, else Codex's default. */
const startingModel = (request: RefineRequest): string =>
  request.model.trim() ||
  (request.provider === "auto" ? "" : savedModelFor(readSavedChoice(), request.provider)) ||
  (request.provider === "codex" ? DEFAULT_REFINE_MODEL : "");

const tryAttempts = (
  request: RefineRequest & { readonly attempts: ReadonlyArray<AttemptTarget>; readonly effort: string },
) =>
  Effect.gen(function* () {
    const errors: Array<string> = [];
    for (const target of request.attempts) {
      request.log(`refine try ${target.provider}/${target.model}`);
      const attempt = yield* Effect.either(
        refineWithProvider({ ...target, effort: request.effort, draft: request.draft }),
      );
      if (attempt._tag === "Right") {
        saveRefineChoice({ provider: target.provider, model: target.model, effort: request.effort });
        return { refined: Option.some(attempt.right), errors };
      }

      const detail = attempt.left.detail;
      errors.push(`${target.provider}/${target.model}: ${detail.slice(0, 400)}`);
      if (target.provider === "codex" && isModelUnavailableError(detail)) {
        markCodexModelFailed(target.model);
      }

      if (!shouldRotate(detail)) {
        break;
      }
    }
    return { refined: Option.none<string>(), errors };
  });

/** Refine with rotation; when every attempt fails, the picker (if allowed) can choose a model or skip refine. */
export const refinePrompt = (request: RefineRequest): Effect.Effect<string, RefineFailed> =>
  Effect.gen(function* () {
    const draft = request.draft.trim();
    if (draft === "") {
      return yield* new RefineFailed({ detail: "Nothing to refine" });
    }

    const effort = request.effort.trim().toLowerCase() || savedEffort() || DEFAULT_REFINE_EFFORT;
    const attempts = yield* attemptQueue({ provider: request.provider, model: startingModel(request) });
    if (attempts.length === 0) {
      return yield* new RefineFailed({
        detail: "No refine provider found on PATH (install codex, claude, grok, ollama, …).",
      });
    }

    const tried = yield* tryAttempts({ ...request, draft, attempts, effort });
    if (Option.isSome(tried.refined)) {
      return tried.refined.value;
    }

    const joined = (tried.errors.join("; ") || "all refine attempts failed").slice(0, 2_000);
    if (!(request.allowPicker && pickerEnabled())) {
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
