import { type ZodError, z } from "zod";

import { MODEL_ALIASES, whisperModelKeys } from "#src/dictation/whisper-models.js";

const NUMBER_KIND = "number";

const FALSE_CHOICE = "false";

const TRUE_CHOICE = "true";

const BOOLEAN_KIND = "boolean";

const FREEFORM_KIND = "text";

const SHIFT_HOLD_KEY = "shift";

const CARET_SEND_TARGET = "caret";

const OFF_MODE = "off";

const HEBREW_LANGUAGE_CODE = "he";

const ENGLISH_LANGUAGE_CODE = "en";

const PI_PROVIDER_ID = "pi";

const GEMINI_PROVIDER_ID = "gemini";

const GROK_PROVIDER_ID = "grok";

const CODEX_PROVIDER_ID = "codex";

const DEFAULT_VOICE_ID = "F4";

const AUTO_CHOICE = "auto";

const createAliasedChoiceSchema = <Choice extends string>(aliases: Readonly<Record<string, Choice>>) =>
  z.string().transform((enteredWords, issueReporter) => {
    const key = enteredWords.trim().toLowerCase();

    const isNotKnownAlias = !Object.hasOwn(aliases, key);
    if (isNotKnownAlias) {
      issueReporter.addIssue({ code: "custom", message: `Unknown value "${enteredWords}".`, input: enteredWords });
      return z.NEVER;
    }

    return aliases[key];
  });

const readLiteralAliases = <Choice extends string>(
  choices: ReadonlyArray<Choice>,
): Readonly<Record<string, Choice>> => {
  const lowercaseLines = choices.map((choice) => [choice.toLowerCase(), choice]);
  return Object.fromEntries(lowercaseLines);
};

const createRangedNumberSchema = (request: {
  readonly range: readonly [number, number];
  readonly outOfRange: string;
  readonly fallback: number;
}) => {
  const [lowest, highest] = request.range;
  return z
    .number()
    .min(lowest, { error: request.outOfRange })
    .max(highest, { error: request.outOfRange })
    .default(request.fallback);
};

const dictationModelChoices = [AUTO_CHOICE, ...whisperModelKeys] as const;

const dictationModelSchema = createAliasedChoiceSchema({ ...MODEL_ALIASES, auto: AUTO_CHOICE });

export const speechVoices = ["F1", "F2", "F3", DEFAULT_VOICE_ID, "F5", "M1", "M2", "M3", "M4", "M5"] as const;

const speechVoiceSchema = createAliasedChoiceSchema(readLiteralAliases(speechVoices));

export const refineProviders = [
  CODEX_PROVIDER_ID,
  AUTO_CHOICE,
  GROK_PROVIDER_ID,
  "ollama",
  "opencode",
  "claude",
  GEMINI_PROVIDER_ID,
  PI_PROVIDER_ID,
] as const;

// The CLI names agents use for the same tools: Grok Build is `agent`, Antigravity is `agy`, pi is also `pie`.
const refineProviderSchema = createAliasedChoiceSchema({
  ...readLiteralAliases(refineProviders),
  agent: GROK_PROVIDER_ID,
  agy: GEMINI_PROVIDER_ID,
  pie: PI_PROVIDER_ID,
});

const dictationLanguages = [ENGLISH_LANGUAGE_CODE, HEBREW_LANGUAGE_CODE] as const;

const dictationLanguageSchema = createAliasedChoiceSchema({
  en: ENGLISH_LANGUAGE_CODE,
  english: ENGLISH_LANGUAGE_CODE,
  "en-us": ENGLISH_LANGUAGE_CODE,
  en_us: ENGLISH_LANGUAGE_CODE,
  "lang=en": ENGLISH_LANGUAGE_CODE,
  he: HEBREW_LANGUAGE_CODE,
  "he-il": HEBREW_LANGUAGE_CODE,
  he_il: HEBREW_LANGUAGE_CODE,
  hebrew: HEBREW_LANGUAGE_CODE,
  ivrit: HEBREW_LANGUAGE_CODE,
  iw: HEBREW_LANGUAGE_CODE,
  "lang=he": HEBREW_LANGUAGE_CODE,
});

const speechModes = [AUTO_CHOICE, "immediate", OFF_MODE] as const;

const refineModes = [OFF_MODE, "clipboard", "dictation", "both"] as const;

const refineSendTargets = [CARET_SEND_TARGET, "cmux-new", "cmux-resume"] as const;

const refineEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;

const dictationHoldKeys = [SHIFT_HOLD_KEY, "right-option"] as const;

const defaultKeepListeningSeconds = 0.2;

const maximumKeepListeningSeconds = 2;

const defaultWordsPerMinute = 230;

const maximumWordsPerMinute = 720;

const minimumWordsPerMinute = 80;

export const settingsSchema = z.strictObject({
  speechMode: z.enum(speechModes).default(AUTO_CHOICE),
  speechMuted: z.boolean().default(true),
  speechVoice: speechVoiceSchema.default(DEFAULT_VOICE_ID),
  speechWordsPerMinute: createRangedNumberSchema({
    range: [minimumWordsPerMinute, maximumWordsPerMinute],
    outOfRange: "Speech rate must be between 80 and 720 words per minute.",
    fallback: defaultWordsPerMinute,
  }),
  dictationHoldKey: z.enum(dictationHoldKeys).default(SHIFT_HOLD_KEY),
  dictationLanguage: dictationLanguageSchema.default(ENGLISH_LANGUAGE_CODE),
  dictationModel: dictationModelSchema.default(AUTO_CHOICE),
  dictationKeepListeningSeconds: createRangedNumberSchema({
    range: [0, maximumKeepListeningSeconds],
    outOfRange: "Dictation keep-listening time must be between 0 and 2 seconds.",
    fallback: defaultKeepListeningSeconds,
  }),
  dictationReplacements: z.string().trim().default(""),
  refineMode: z.enum(refineModes).default(OFF_MODE),
  refineProvider: refineProviderSchema.default(CODEX_PROVIDER_ID),
  refineModel: z.string().trim().min(1).optional(),
  refineEffort: z.enum(refineEfforts).optional(),
  refinePressEnter: z.boolean().default(false),
  refineSendTo: z.enum(refineSendTargets).default(CARET_SEND_TARGET),
  refineCmuxCommand: z.string().trim().default(""),
  refineCmuxPressEnter: z.boolean().default(false),
});

export type Settings = z.infer<typeof settingsSchema>;

type SettingsKey = keyof Settings;

const describeSettingsIssues = (error: ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");

export const decodeSettings = (storedSettings: unknown): Settings => {
  const checkedReply = settingsSchema.safeParse(storedSettings);

  const isReplyInvalid = !checkedReply.success;
  if (isReplyInvalid) {
    const settingsIssueSummary = describeSettingsIssues(checkedReply.error);
    throw new Error(settingsIssueSummary);
  }

  return checkedReply.data;
};

export const defaultSettings: Settings = decodeSettings({});

type SettingKind = "number" | "boolean" | "text";

export interface SettingDefinition {
  readonly key: SettingsKey;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly kind: SettingKind;
  readonly choices: ReadonlyArray<string>;
  readonly optional: boolean;
}

// e.g. "speechWordsPerMinute" → "speech-words-per-minute"
const createSettingName = (key: SettingsKey): string => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

type SettingDetails = Omit<SettingDefinition, "key" | "name">;

const createSetting = (key: SettingsKey, details: SettingDetails): SettingDefinition => ({
  key,
  name: createSettingName(key),
  ...details,
});

// Each setting's CLI label (title) and meaning (description), in the order `agent-voice config list` shows them.
export const settingDefinitions: ReadonlyArray<SettingDefinition> = [
  createSetting("speechMode", {
    label: "speech mode",
    description:
      "When agent replies are read aloud: auto holds a Cmux reply until its surface is focused and Cmux is in front, and speaks other replies at once; immediate speaks every reply at once; off reads nothing.",
    kind: FREEFORM_KIND,
    choices: speechModes,
    optional: false,
  }),
  createSetting("speechMuted", {
    label: "speech muted",
    description:
      "Read nothing while true; replies that arrive meanwhile are dropped, not saved for later. In shift hold-key mode, double-tap Shift flips it (outside clipboard refine mode).",
    kind: BOOLEAN_KIND,
    choices: [TRUE_CHOICE, FALSE_CHOICE],
    optional: false,
  }),
  createSetting("speechVoice", {
    label: "speech voice",
    description: "Supertonic voice: F1-F5 or M1-M5.",
    kind: FREEFORM_KIND,
    choices: speechVoices,
    optional: false,
  }),
  createSetting("speechWordsPerMinute", {
    label: "speech rate (words per minute)",
    description: "Speed of read-aloud replies, in words per minute (the voice speed is clamped to 0.7-2.0x).",
    kind: NUMBER_KIND,
    choices: [],
    optional: false,
  }),
  createSetting("dictationHoldKey", {
    label: "dictation hold key",
    description:
      "Hold alone to dictate: shift or right-option. Right Option is hold-only: taps do nothing. Changing this restarts dictation.",
    kind: FREEFORM_KIND,
    choices: dictationHoldKeys,
    optional: false,
  }),
  createSetting("dictationLanguage", {
    label: "dictation language",
    description:
      "Dictation language: en (whisper.cpp large-v3-turbo) or he (ivrit.ai Hebrew large-v3-turbo). Accepts english, hebrew, ivrit, iw. With dictation-model auto it picks the model.",
    kind: FREEFORM_KIND,
    choices: dictationLanguages,
    optional: false,
  }),
  createSetting("dictationModel", {
    label: "dictation model",
    description:
      "Whisper model for dictation: auto (turbo-q5 for en, ivrit for he), tiny, base, small, turbo-q5, turbo-q8, turbo, or ivrit. The tiny, base, and small models are English only and ivrit is Hebrew only: set dictation-language to match. Changing it downloads the model if missing and restarts dictation. AGENT_VOICE_DICTATION_MODEL overrides it.",
    kind: FREEFORM_KIND,
    choices: dictationModelChoices,
    optional: false,
  }),
  createSetting("dictationKeepListeningSeconds", {
    label: "dictation keep listening (seconds)",
    description: "Seconds the microphone stays open after the hold key is released, so trailing words are not cut off.",
    kind: NUMBER_KIND,
    choices: [],
    optional: false,
  }),
  createSetting("dictationReplacements", {
    label: "dictation replacements",
    description:
      "Semicolon-separated heard=written pairs applied to dictation, e.g. Joseph=Yosef;type script=TypeScript.",
    kind: FREEFORM_KIND,
    choices: [],
    optional: false,
  }),
  createSetting("refineMode", {
    label: "refine mode",
    description:
      "Prompt refine: off; clipboard = double-tap Shift (in shift hold-key mode) refines the copied prompt; dictation = refine the dictation before it is typed; both.",
    kind: FREEFORM_KIND,
    choices: refineModes,
    optional: false,
  }),
  createSetting("refineProvider", {
    label: "refine provider",
    description:
      "Agent CLI that refines: codex | auto | grok | ollama | opencode | claude | gemini | pi. `agent-voice config pick-refine` lists only the CLIs found on this Mac.",
    kind: FREEFORM_KIND,
    choices: refineProviders,
    optional: false,
  }),
  createSetting("refineModel", {
    label: "refine model",
    description:
      "Model ID for the refine provider (e.g. gpt-5.3-codex-spark, grok-4.5, llama3.2). Unset: gpt-5.3-codex-spark for codex, the provider's own models otherwise.",
    kind: FREEFORM_KIND,
    choices: [],
    optional: true,
  }),
  createSetting("refineEffort", {
    label: "refine effort",
    description: "Reasoning effort for providers that support it. Unset: low, so dictation refine stays fast.",
    kind: FREEFORM_KIND,
    choices: refineEfforts,
    optional: true,
  }),
  createSetting("refinePressEnter", {
    label: "refine press Enter",
    description: "Press Enter after dictated text (refined or not) is typed at the caret.",
    kind: BOOLEAN_KIND,
    choices: [TRUE_CHOICE, FALSE_CHOICE],
    optional: false,
  }),
  createSetting("refineSendTo", {
    label: "refine send to",
    description:
      "Where refined dictation goes: caret (the focused input), cmux-new (a new focused cmux workspace), or cmux-resume (the focused cmux surface).",
    kind: FREEFORM_KIND,
    choices: refineSendTargets,
    optional: false,
  }),
  createSetting("refineCmuxCommand", {
    label: "refine cmux command",
    description:
      "Shell command run in the new cmux workspace for cmux-new. Placeholders, each replaced by one shell-quoted word: {{prompt_file}}, {{prompt}}, {{cwd}}. Empty pastes the text only.",
    kind: FREEFORM_KIND,
    choices: [],
    optional: false,
  }),
  createSetting("refineCmuxPressEnter", {
    label: "refine cmux press Enter",
    description: "Press Enter after sending refined text into cmux (cmux-resume, or cmux-new without a command).",
    kind: BOOLEAN_KIND,
    choices: [TRUE_CHOICE, FALSE_CHOICE],
    optional: false,
  }),
];

export type SettingsField = string | number | boolean;

const parseNumberWord = (trimmed: string): number => {
  const number = Number(trimmed);

  const isNotANumber = trimmed === "" || Number.isNaN(number);
  if (isNotANumber) {
    throw new Error(`Expected a number, actual "${trimmed}".`);
  }

  return number;
};

const parseBooleanWord = (trimmed: string): boolean => {
  const isTrue = trimmed === TRUE_CHOICE;
  const isFalse = trimmed === FALSE_CHOICE;

  if (isTrue) {
    return true;
  }

  if (isFalse) {
    return false;
  }

  throw new Error(`Expected true or false, actual "${trimmed}".`);
};

export const parseSettingField = (request: {
  readonly setting: SettingDefinition;
  readonly enteredWords: string;
}): SettingsField | null => {
  const trimmed = request.enteredWords.trim();

  const isClearedOptional = request.setting.optional && trimmed === "";
  if (isClearedOptional) {
    return null;
  }

  switch (request.setting.kind) {
    case NUMBER_KIND:
      return parseNumberWord(trimmed);
    case BOOLEAN_KIND:
      return parseBooleanWord(trimmed);
    case FREEFORM_KIND:
      return request.enteredWords;
  }
};

// A cleared optional setting leaves config.json without the key instead of storing an empty value.
export const setSettingField = (request: {
  readonly config: Settings;
  readonly key: SettingsKey;
  readonly value: SettingsField | null;
}): Settings => {
  const isCleared = request.value == null;
  const changedSettings = isCleared
    ? Object.fromEntries(Object.entries(request.config).filter(([key]) => key !== request.key))
    : { ...request.config, [request.key]: request.value };
  return decodeSettings(changedSettings);
};
