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

const NO_PROVIDERS_MESSAGE =
  "No agent CLI found on PATH (codex, claude, gemini, grok, ollama, opencode, pi). Install one, then try again.";

const refinePickSchema = Schema.Struct({
  provider: providerIdSchema,
  model: Schema.String,
  effort: Schema.String,
});

export type RefinePick = Schema.Schema.Type<typeof refinePickSchema>;

const PICKER_TITLE = "agent-voice refine";
const DIALOG_TIMEOUT_MS = 300_000;
const ALERT_TIMEOUT_MS = 60_000;

// The picker runs only on a Mac, outside CI, and unless AGENT_VOICE_REFINE_PICKER is off.
export const pickerEnabled = (): boolean => {
  const environment = readEnvironment();
  return environment.AGENT_VOICE_REFINE_PICKER && environment.CI === "" && process.platform === "darwin";
};

const appleScriptText = (text: string): string => text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');

const appleScriptList = (items: ReadonlyArray<string>): string => {
  const quotedItems = items.map((item) => `"${appleScriptText(item)}"`);
  return `{${quotedItems.join(", ")}}`;
};

// AppleScript preselects the first item, so the default goes first.
const defaultFirst = (items: ReadonlyArray<string>, defaultItem: string): ReadonlyArray<string> => {
  if (!items.includes(defaultItem)) {
    return items;
  }

  const otherItems = items.filter((item) => item !== defaultItem);
  return [defaultItem, ...otherItems];
};

const chosenItem = (stdout: string): Option.Option<string> => {
  const chosen = stdout.trim();
  const isDismissed = chosen === "" || chosen === "CANCEL" || chosen.startsWith("ERROR:");
  if (isDismissed) {
    return Option.none();
  }

  return Option.some(chosen);
};

const chooseFromList = (request: {
  readonly prompt: string;
  readonly items: ReadonlyArray<string>;
  readonly defaultItem: string;
}): Effect.Effect<Option.Option<string>> => {
  const ordered = defaultFirst(request.items, request.defaultItem);
  if (ordered.length === 0) {
    return Effect.succeedNone;
  }

  const itemList = appleScriptList(ordered);
  const prompt = appleScriptText(request.prompt);
  const script = `try
  set theList to ${itemList}
  set theChoice to choose from list theList with title "${PICKER_TITLE}" with prompt "${prompt}" default items {item 1 of theList} OK button name "Use" cancel button name "Cancel"
  if theChoice is false then
    return "CANCEL"
  end if
  return item 1 of theChoice
on error errMsg
  return "ERROR:" & errMsg
end try`;
  return runCli({ executable: "osascript", args: ["-e", script], timeoutMs: DIALOG_TIMEOUT_MS }).pipe(
    Effect.map((cliRun) => chosenItem(cliRun.stdout)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};

const showAlert = (request: { readonly title: string; readonly message: string }): Effect.Effect<void> => {
  const title = appleScriptText(request.title);
  const shortMessage = request.message.slice(0, 900);
  const message = appleScriptText(shortMessage);
  const script = `try\n  display alert "${title}" message "${message}" as warning buttons {"OK"} default button "OK"\nend try`;
  return runCli({ executable: "osascript", args: ["-e", script], timeoutMs: ALERT_TIMEOUT_MS }).pipe(Effect.ignore);
};

const listedModels = (providers: ReadonlyArray<DiscoveredProvider>, id: DiscoveredProvider["id"]) => {
  const listed = providers.find((provider) => provider.id === id);
  if (listed === undefined) {
    return [];
  }

  return listed.models;
};

// Another provider's model is never offered (or saved) after switching provider.
const preferredModelFor = (
  preferred: { readonly provider: string; readonly model: string },
  provider: DiscoveredProvider["id"],
): string => {
  if (preferred.provider !== provider) {
    return "";
  }

  return preferred.model;
};

const savedCodexModel = (): string =>
  readSavedChoice().pipe(
    Option.filter((choice) => choice.provider === "codex"),
    Option.map((choice) => choice.model),
    Option.getOrElse(() => ""),
  );

// Codex adds its last-good, saved, cached and curated models.
export const pickerModels = (request: {
  readonly provider: DiscoveredProvider["id"];
  readonly providers: ReadonlyArray<DiscoveredProvider>;
  readonly preferred: { readonly provider: string; readonly model: string };
}): ReadonlyArray<string> => {
  const listed = listedModels(request.providers, request.provider);
  const preferred = preferredModelFor(request.preferred, request.provider);
  if (request.provider !== "codex") {
    return dedupe([preferred, ...listed]);
  }

  const lastGood = codexLastGoodModel();
  const saved = savedCodexModel();
  const cached = codexCachedModels();
  return dedupe([preferred, lastGood, saved, ...listed, ...cached, ...CODEX_PICKER_MODELS, ...CODEX_MODEL_FALLBACKS]);
};

const providerLabel = (provider: DiscoveredProvider): string =>
  `${provider.id}  (${provider.binary}, ${String(provider.models.length)} models)`;

const defaultProviderLabel = (providers: ReadonlyArray<DiscoveredProvider>, preferredProvider: string): string => {
  const preferred = providers.find((provider) => provider.id === preferredProvider) || providers[0];
  if (preferred === undefined) {
    return "";
  }

  return providerLabel(preferred);
};

const providerWithLabel = (
  providers: ReadonlyArray<DiscoveredProvider>,
  label: string,
): Option.Option<DiscoveredProvider> => {
  const labeled = providers.find((provider) => providerLabel(provider) === label);
  return Option.fromNullable(labeled);
};

const modelItems = (request: {
  readonly models: ReadonlyArray<string>;
  readonly offerSkip: boolean;
}): ReadonlyArray<string> => {
  if (!request.offerSkip) {
    return request.models;
  }

  return [...request.models, SKIP_REFINE_LABEL];
};

// None when cancelled or no provider is installed; the model is SKIP_REFINE_LABEL when the user skips.
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

    const chosenLabel = yield* chooseFromList({
      prompt: "Provider (found on this Mac):",
      items: providers.map(providerLabel),
      defaultItem: defaultProviderLabel(providers, request.preferredProvider),
    });
    const provider = chosenLabel.pipe(Option.flatMap((label) => providerWithLabel(providers, label)));
    if (Option.isNone(provider)) {
      return Option.none();
    }

    const providerId = provider.value.id;
    const models = pickerModels({
      provider: providerId,
      providers,
      preferred: { provider: request.preferredProvider, model: request.preferredModel },
    });
    const model = yield* chooseFromList({
      prompt: `Model for ${providerId}:`,
      items: modelItems({ models, offerSkip: request.offerSkip }),
      defaultItem: models[0] || "",
    });
    if (Option.isNone(model)) {
      return Option.none();
    }

    const isSkipped = model.value === SKIP_REFINE_LABEL;
    if (isSkipped || !provider.value.effort) {
      return Option.some({ provider: providerId, model: model.value, effort: "" });
    }

    const effortDefault =
      REASONING_EFFORTS.find((effort) => effort === request.preferredEffort) || DEFAULT_REFINE_EFFORT;
    const effort = yield* chooseFromList({
      prompt: `Reasoning effort for ${model.value}:`,
      items: REASONING_EFFORTS,
      defaultItem: effortDefault,
    });
    return effort.pipe(Option.map((chosen) => ({ provider: providerId, model: model.value, effort: chosen })));
  });
