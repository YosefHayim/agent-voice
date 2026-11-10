import { readEnvironment } from "#src/settings/environment-variables.js";
import { type CliRun, dedupe, runCli } from "./agent-cli.js";
import {
  CODEX_MODEL_FALLBACKS,
  CODEX_PICKER_MODELS,
  type DiscoveredProvider,
  discoverProviders,
  listCodexCachedModels,
  type ProviderId,
  REASONING_EFFORTS,
} from "./provider-models.js";
import { DEFAULT_REFINE_EFFORT, readCodexLastGoodModel, readSavedChoice } from "./refine-choices.js";

// ASCII hyphens: AppleScript "choose from list" can choke on em dashes.
export const SKIP_REFINE_LABEL = "-- Skip refine (keep the dictated text) --";

const NO_PROVIDERS_MESSAGE =
  "No agent CLI found on PATH (codex, claude, gemini, grok, ollama, opencode, pi). Install one, then try again.";

export interface RefinePick {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: string;
}

const PICKER_TITLE = "agent-voice refine";
const DIALOG_TIMEOUT_MS = 300_000;
const ALERT_TIMEOUT_MS = 60_000;

// The picker runs only on a Mac, outside CI, and unless AGENT_VOICE_REFINE_PICKER is off.
export const isPickerEnabled = (): boolean => {
  const environment = readEnvironment();
  return environment.AGENT_VOICE_REFINE_PICKER && environment.CI === "" && process.platform === "darwin";
};

const escapeAppleScriptString = (plainString: string): string =>
  plainString.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');

const createAppleScriptList = (labels: ReadonlyArray<string>): string => {
  const quotedLabels = labels.map((label) => `"${escapeAppleScriptString(label)}"`);
  return `{${quotedLabels.join(", ")}}`;
};

// AppleScript preselects the first label, so the default goes first.
const moveDefaultFirst = (labels: ReadonlyArray<string>, defaultLabel: string): ReadonlyArray<string> => {
  const isDefaultMissing = !labels.includes(defaultLabel);
  if (isDefaultMissing) {
    return labels;
  }

  const otherLabels = labels.filter((label) => label !== defaultLabel);
  return [defaultLabel, ...otherLabels];
};

// Null when the user dismisses the dialog or the dialog reports an error.
const readChosenLabel = (stdout: string): string | null => {
  const chosen = stdout.trim();

  const isDismissed = chosen === "" || chosen === "CANCEL" || chosen.startsWith("ERROR:");
  if (isDismissed) {
    return null;
  }

  return chosen;
};

const runOsascript = (script: string, timeoutMilliseconds: number): Promise<CliRun> =>
  runCli({
    executable: "osascript",
    args: ["-e", script],
    timeoutMs: timeoutMilliseconds,
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });

const chooseFromList = async (request: {
  readonly prompt: string;
  readonly labels: ReadonlyArray<string>;
  readonly defaultLabel: string;
}): Promise<string | null> => {
  const orderedLabels = moveDefaultFirst(request.labels, request.defaultLabel);

  const hasNoLabels = orderedLabels.length === 0;
  if (hasNoLabels) {
    return null;
  }

  const labelList = createAppleScriptList(orderedLabels);
  const prompt = escapeAppleScriptString(request.prompt);
  const script = `try
  set theList to ${labelList}
  set theChoice to choose from list theList with title "${PICKER_TITLE}" with prompt "${prompt}" default items {item 1 of theList} OK button name "Use" cancel button name "Cancel"
  if theChoice is false then
    return "CANCEL"
  end if
  return item 1 of theChoice
on error errMsg
  return "ERROR:" & errMsg
end try`;
  try {
    const pickerRun = await runOsascript(script, DIALOG_TIMEOUT_MS);
    return readChosenLabel(pickerRun.stdout);
  } catch (error) {
    console.error({ prompt: request.prompt, error });
    return null;
  }
};

const showAlert = async (request: { readonly title: string; readonly message: string }): Promise<void> => {
  const title = escapeAppleScriptString(request.title);
  const shortMessage = request.message.slice(0, 900);
  const message = escapeAppleScriptString(shortMessage);
  const script = `try\n  display alert "${title}" message "${message}" as warning buttons {"OK"} default button "OK"\nend try`;
  try {
    await runOsascript(script, ALERT_TIMEOUT_MS);
  } catch (error) {
    console.error({ title: request.title, error });
  }
};

const readListedModels = (providers: ReadonlyArray<DiscoveredProvider>, id: ProviderId): ReadonlyArray<string> => {
  const listed = providers.find((provider) => provider.id === id);

  const isListedMissing = listed === undefined;
  if (isListedMissing) {
    return [];
  }

  return listed.models;
};

// Another provider's model is never offered (or saved) after switching provider.
const pickPreferredModel = (
  preferred: { readonly provider: string; readonly model: string },
  provider: ProviderId,
): string => {
  const isOtherProvider = preferred.provider !== provider;
  if (isOtherProvider) {
    return "";
  }

  return preferred.model;
};

const readSavedCodexModel = (): string => {
  const saved = readSavedChoice();

  const isSavedMissing = saved === null;
  if (isSavedMissing) {
    return "";
  }

  const isNotSavedCodex = saved.provider !== "codex";
  if (isNotSavedCodex) {
    return "";
  }

  return saved.model;
};

// Codex adds its last-good, saved, cached and curated models.
export const listPickerModels = (request: {
  readonly provider: ProviderId;
  readonly providers: ReadonlyArray<DiscoveredProvider>;
  readonly preferred: { readonly provider: string; readonly model: string };
}): ReadonlyArray<string> => {
  const listed = readListedModels(request.providers, request.provider);
  const preferred = pickPreferredModel(request.preferred, request.provider);

  const isNotCodex = request.provider !== "codex";
  if (isNotCodex) {
    return dedupe([preferred, ...listed]);
  }

  const lastGood = readCodexLastGoodModel();
  const saved = readSavedCodexModel();
  const cached = listCodexCachedModels();
  return dedupe([preferred, lastGood, saved, ...listed, ...cached, ...CODEX_PICKER_MODELS, ...CODEX_MODEL_FALLBACKS]);
};

const createProviderLabel = (provider: DiscoveredProvider): string =>
  `${provider.id}  (${provider.binary}, ${String(provider.models.length)} models)`;

const pickDefaultProviderLabel = (providers: ReadonlyArray<DiscoveredProvider>, preferredProvider: string): string => {
  const preferred = providers.find((provider) => provider.id === preferredProvider) ?? providers[0];

  const isPreferredMissing = preferred === undefined;
  if (isPreferredMissing) {
    return "";
  }

  return createProviderLabel(preferred);
};

const findProviderWithLabel = (
  providers: ReadonlyArray<DiscoveredProvider>,
  label: string,
): DiscoveredProvider | null => providers.find((provider) => createProviderLabel(provider) === label) ?? null;

const listModelLabels = (request: {
  readonly models: ReadonlyArray<string>;
  readonly offerSkip: boolean;
}): ReadonlyArray<string> => {
  const isOfferSkipOff = !request.offerSkip;
  if (isOfferSkipOff) {
    return request.models;
  }

  return [...request.models, SKIP_REFINE_LABEL];
};

// Null when cancelled or no provider is installed; the model is SKIP_REFINE_LABEL when the user skips.
export const pickRefineTargetWithDialogs = async (request: {
  readonly reason: string;
  readonly preferredProvider: string;
  readonly preferredModel: string;
  readonly preferredEffort: string;
  readonly offerSkip: boolean;
}): Promise<RefinePick | null> => {
  const providers = await discoverProviders({ refresh: false });

  const hasNoProviders = providers.length === 0;
  if (hasNoProviders) {
    await showAlert({ title: "No refine providers", message: NO_PROVIDERS_MESSAGE });
    return null;
  }

  const hasReason = request.reason !== "";
  if (hasReason) {
    await showAlert({ title: "Prompt refine — pick provider / model", message: request.reason });
  }

  const chosenLabel = await chooseFromList({
    prompt: "Provider (found on this Mac):",
    labels: providers.map(createProviderLabel),
    defaultLabel: pickDefaultProviderLabel(providers, request.preferredProvider),
  });

  const isProviderDismissed = chosenLabel === null;
  if (isProviderDismissed) {
    return null;
  }

  const provider = findProviderWithLabel(providers, chosenLabel);

  const isProviderUnknown = provider === null;
  if (isProviderUnknown) {
    return null;
  }

  const providerId = provider.id;
  const models = listPickerModels({
    provider: providerId,
    providers,
    preferred: { provider: request.preferredProvider, model: request.preferredModel },
  });
  const chosenModel = await chooseFromList({
    prompt: `Model for ${providerId}:`,
    labels: listModelLabels({ models, offerSkip: request.offerSkip }),
    defaultLabel: models[0] || "",
  });

  const isModelDismissed = chosenModel === null;
  if (isModelDismissed) {
    return null;
  }

  const isSkipped = chosenModel === SKIP_REFINE_LABEL;

  const hasNoEffort = !provider.effort;

  const isEffortSkipped = isSkipped || hasNoEffort;
  if (isEffortSkipped) {
    return { provider: providerId, model: chosenModel, effort: "" };
  }

  const effortDefault = REASONING_EFFORTS.find((effort) => effort === request.preferredEffort) ?? DEFAULT_REFINE_EFFORT;
  const chosenEffort = await chooseFromList({
    prompt: `Reasoning effort for ${chosenModel}:`,
    labels: REASONING_EFFORTS,
    defaultLabel: effortDefault,
  });

  const isEffortDismissed = chosenEffort === null;
  if (isEffortDismissed) {
    return null;
  }

  return { provider: providerId, model: chosenModel, effort: chosenEffort };
};
