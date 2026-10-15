/** The macOS refine picker: native dialogs to choose a provider found on this Mac, a model, and an effort. */

import { Effect, Option, Schema } from "effect";

import { readEnvironment } from "../settings/environmentVariables.js";
import { dedupe, runCli } from "./agentCli.js";
import {
  CODEX_MODEL_FALLBACKS,
  CODEX_PICKER_MODELS,
  codexCachedModels,
  type DiscoveredProvider,
  discoverProviders,
  providerIdSchema,
  REASONING_EFFORTS,
} from "./providerModels.js";
import { codexLastGoodModel, DEFAULT_REFINE_EFFORT, readSavedChoice } from "./refineChoices.js";

// ASCII hyphens: AppleScript "choose from list" can choke on em dashes.
export const SKIP_REFINE_LABEL = "-- Skip refine (keep the dictated text) --";

export const NO_PROVIDERS_MESSAGE =
  "No agent CLI found on PATH (codex, claude, gemini, grok, ollama, opencode, pi). Install one, then try again.";

export const refinePickSchema = Schema.Struct({
  provider: providerIdSchema,
  model: Schema.String,
  effort: Schema.String,
});

export type RefinePick = Schema.Schema.Type<typeof refinePickSchema>;

/** The picker runs only on a Mac, outside CI, and unless VOXKEY_REFINE_PICKER is off. */
export const pickerEnabled = (): boolean => {
  const environment = readEnvironment();
  return environment.VOXKEY_REFINE_PICKER && environment.CI === "" && process.platform === "darwin";
};

const appleScriptText = (text: string): string => text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');

const DIALOG_TIMEOUT_MS = 300_000;

/** A native list picker; none when cancelled. AppleScript preselects the first item, so the default goes first. */
export const chooseFromList = (request: {
  readonly title: string;
  readonly prompt: string;
  readonly items: ReadonlyArray<string>;
  readonly defaultItem: string;
}): Effect.Effect<Option.Option<string>> => {
  const ordered = request.items.includes(request.defaultItem)
    ? [request.defaultItem, ...request.items.filter((item) => item !== request.defaultItem)]
    : request.items;
  const script = `try
  set theList to {${ordered.map((item) => `"${appleScriptText(item)}"`).join(", ")}}
  set theChoice to choose from list theList with title "${appleScriptText(request.title)}" with prompt "${appleScriptText(request.prompt)}" default items {item 1 of theList} OK button name "Use" cancel button name "Cancel"
  if theChoice is false then
    return "CANCEL"
  end if
  return item 1 of theChoice
on error errMsg
  return "ERROR:" & errMsg
end try`;
  if (ordered.length === 0) {
    return Effect.succeed(Option.none());
  }

  return runCli({ executable: "osascript", args: ["-e", script], timeoutMs: DIALOG_TIMEOUT_MS }).pipe(
    Effect.map((cliRun) => cliRun.stdout.trim()),
    Effect.map((chosen) =>
      chosen === "" || chosen === "CANCEL" || chosen.startsWith("ERROR:") ? Option.none() : Option.some(chosen),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};

export const showAlert = (request: { readonly title: string; readonly message: string }): Effect.Effect<void> =>
  runCli({
    executable: "osascript",
    args: [
      "-e",
      `try\n  display alert "${appleScriptText(request.title)}" message "${appleScriptText(request.message.slice(0, 900))}" as warning buttons {"OK"} default button "OK"\nend try`,
    ],
    timeoutMs: 60_000,
  }).pipe(Effect.ignore);

/**
 * Model IDs offered for one discovered provider; Codex adds its cached and curated lists. The preferred model and
 * the saved pick come first only when they belong to this provider, so switching provider never offers (or saves)
 * another provider's model.
 */
export const pickerModels = (request: {
  readonly provider: DiscoveredProvider["id"];
  readonly providers: ReadonlyArray<DiscoveredProvider>;
  readonly preferred: { readonly provider: string; readonly model: string };
}): ReadonlyArray<string> => {
  const listed = request.providers.find((provider) => provider.id === request.provider)?.models || [];
  const preferred = request.preferred.provider === request.provider ? request.preferred.model : "";
  if (request.provider !== "codex") {
    return dedupe([preferred, ...listed]);
  }

  const saved = Option.match(
    Option.filter(readSavedChoice(), (choice) => choice.provider === "codex"),
    { onNone: () => "", onSome: (choice) => choice.model },
  );
  return dedupe([
    preferred,
    codexLastGoodModel(),
    saved,
    ...listed,
    ...codexCachedModels(),
    ...CODEX_PICKER_MODELS,
    ...CODEX_MODEL_FALLBACKS,
  ]);
};

const providerLabel = (provider: DiscoveredProvider) =>
  `${provider.id}  (${provider.binary}, ${String(provider.models.length)} models)`;

/**
 * Ask with macOS dialogs for a provider, a model, and (when the provider supports it) an effort.
 * None when cancelled or no provider is installed; the model is SKIP_REFINE_LABEL when the user skips.
 */
export const pickRefineTargetWithDialogs = (request: {
  readonly reason: string;
  readonly preferredProvider: string;
  readonly preferredModel: string;
  readonly preferredEffort: string;
  readonly offerSkip: boolean;
}): Effect.Effect<Option.Option<RefinePick>> =>
  Effect.gen(function* () {
    const providers = yield* discoverProviders({ refresh: false });
    if (providers.length === 0) {
      yield* showAlert({ title: "No refine providers", message: NO_PROVIDERS_MESSAGE });
      return Option.none();
    }

    if (request.reason !== "") {
      yield* showAlert({ title: "Prompt refine — pick provider / model", message: request.reason });
    }

    const labels = providers.map(providerLabel);
    const preferred = providers.find((provider) => provider.id === request.preferredProvider);
    const chosenLabel = yield* chooseFromList({
      title: "voxkey refine",
      prompt: "Provider (found on this Mac):",
      items: labels,
      defaultItem: preferred === undefined ? labels[0] || "" : providerLabel(preferred),
    });
    const provider = Option.flatMap(chosenLabel, (label) => Option.fromNullable(providers[labels.indexOf(label)]));
    if (Option.isNone(provider)) {
      return Option.none();
    }

    const models = pickerModels({
      provider: provider.value.id,
      providers,
      preferred: { provider: request.preferredProvider, model: request.preferredModel },
    });
    const model = yield* chooseFromList({
      title: "voxkey refine",
      prompt: `Model for ${provider.value.id}:`,
      items: request.offerSkip ? [...models, SKIP_REFINE_LABEL] : models,
      defaultItem: models[0] || "",
    });
    if (Option.isNone(model) || model.value === SKIP_REFINE_LABEL || !provider.value.effort) {
      return Option.map(model, (chosen) => ({ provider: provider.value.id, model: chosen, effort: "" }));
    }

    const effortDefault =
      REASONING_EFFORTS.find((effort) => effort === request.preferredEffort) || DEFAULT_REFINE_EFFORT;
    const effort = yield* chooseFromList({
      title: "voxkey refine",
      prompt: `Reasoning effort for ${model.value}:`,
      items: REASONING_EFFORTS,
      defaultItem: effortDefault,
    });
    return Option.map(effort, (chosen) => ({ provider: provider.value.id, model: model.value, effort: chosen }));
  });
