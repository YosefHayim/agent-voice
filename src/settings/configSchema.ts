import { Effect, Option, ParseResult, Schema, SchemaAST, Struct } from "effect";

const withDefault = <Value, Encoded>(schema: Schema.Schema<Value, Encoded>, fallback: Value) =>
  Schema.optionalWith(schema, { default: () => fallback, exact: true });

const numberSetting = (setting: {
  readonly range: readonly [number, number];
  readonly outOfRange: string;
  readonly fallback: number;
  readonly title: string;
  readonly description: string;
}) => {
  const rangedNumber = Schema.Number.pipe(Schema.between(...setting.range, { message: () => setting.outOfRange }));
  return withDefault(rangedNumber, setting.fallback).annotations({
    title: setting.title,
    description: setting.description,
  });
};

// A closed choice that also accepts any letter case and the listed aliases ("Hebrew" → "he").
const choiceWithAliases = <Choice extends string>(request: {
  readonly choices: Schema.Schema<Choice>;
  readonly aliases: Readonly<Record<string, Choice>>;
}) =>
  Schema.transformOrFail(Schema.String, request.choices, {
    strict: true,
    decode: (text) => {
      const key = text.trim().toLowerCase();
      const alias = Object.entries(request.aliases).find(([name]) => name === key);
      if (alias === undefined) {
        return ParseResult.fail(new ParseResult.Type(request.choices.ast, text, `Unknown value "${text}".`));
      }

      return ParseResult.succeed(alias[1]);
    },
    encode: (choice) => ParseResult.succeed(choice),
  });

const literalAliases = <Choice extends string>(choices: ReadonlyArray<Choice>): Readonly<Record<string, Choice>> => {
  const lowercaseEntries = choices.map((choice) => [choice.toLowerCase(), choice]);
  return Object.fromEntries(lowercaseEntries);
};

export const speechVoices = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;

const speechVoiceSchema = choiceWithAliases({
  choices: Schema.Literal(...speechVoices),
  aliases: literalAliases(speechVoices),
});

export const refineProviders = ["codex", "auto", "grok", "ollama", "opencode", "claude", "gemini", "pi"] as const;

// The CLI names agents use for the same tools: Grok Build is `agent`, Antigravity is `agy`, pi is also `pie`.
const refineProviderSchema = choiceWithAliases({
  choices: Schema.Literal(...refineProviders),
  aliases: { ...literalAliases(refineProviders), agent: "grok", agy: "gemini", pie: "pi" },
});

const dictationLanguageSchema = choiceWithAliases({
  choices: Schema.Literal("en", "he"),
  aliases: {
    en: "en",
    english: "en",
    "en-us": "en",
    en_us: "en",
    "lang=en": "en",
    he: "he",
    "he-il": "he",
    he_il: "he",
    hebrew: "he",
    ivrit: "he",
    iw: "he",
    "lang=he": "he",
  },
});

const trimmedText = Schema.Trim;

const speechModeSchema = Schema.Literal("auto", "immediate", "off");

const refineModeSchema = Schema.Literal("off", "clipboard", "dictation", "both");

const refineSendToSchema = Schema.Literal("caret", "cmux-new", "cmux-resume");

// Every setting carries its CLI label (title) and meaning (description) on its property signature,
// so `voxkey config list`, `voxkey config set`, and the README all read one declaration.
export const configSchema = Schema.Struct({
  speechMode: withDefault(speechModeSchema, "auto").annotations({
    title: "speech mode",
    description:
      "When agent replies are read aloud: auto holds a Cmux reply until its surface is focused and Cmux is in front, and speaks other replies at once; immediate speaks every reply at once; off reads nothing.",
  }),
  speechMuted: withDefault(Schema.Boolean, true).annotations({
    title: "speech muted",
    description:
      "Read nothing while true; replies that arrive meanwhile are dropped, not saved for later. Double-tap Shift flips it (outside clipboard refine mode).",
  }),
  speechVoice: withDefault(speechVoiceSchema, "F4").annotations({
    title: "speech voice",
    description: "Supertonic voice: F1-F5 or M1-M5.",
  }),
  speechWordsPerMinute: numberSetting({
    range: [80, 720],
    outOfRange: "Speech rate must be between 80 and 720 words per minute.",
    fallback: 230,
    title: "speech rate (words per minute)",
    description: "Speed of read-aloud replies, in words per minute (the voice speed is clamped to 0.7-2.0x).",
  }),
  dictationLanguage: withDefault(dictationLanguageSchema, "en").annotations({
    title: "dictation language",
    description:
      "Dictation language: en (whisper.cpp large-v3-turbo) or he (ivrit.ai Hebrew large-v3-turbo). Accepts english, hebrew, ivrit, iw.",
  }),
  dictationKeepListeningSeconds: numberSetting({
    range: [0, 2],
    outOfRange: "Dictation keep-listening time must be between 0 and 2 seconds.",
    fallback: 0.2,
    title: "dictation keep listening (seconds)",
    description: "Seconds the microphone stays open after Shift is released, so trailing words are not cut off.",
  }),
  dictationReplacements: withDefault(trimmedText, "").annotations({
    title: "dictation replacements",
    description:
      "Semicolon-separated heard=written pairs applied to dictation, e.g. Joseph=Yosef;type script=TypeScript.",
  }),
  refineMode: withDefault(refineModeSchema, "off").annotations({
    title: "refine mode",
    description:
      "Prompt refine: off; clipboard = double-tap Shift refines the copied prompt; dictation = refine the dictation before it is typed; both.",
  }),
  refineProvider: withDefault(refineProviderSchema, "codex").annotations({
    title: "refine provider",
    description:
      "Agent CLI that refines: codex | auto | grok | ollama | opencode | claude | gemini | pi. `voxkey config pick-refine` lists only the CLIs found on this Mac.",
  }),
  refineModel: Schema.optionalWith(Schema.NonEmptyTrimmedString, { exact: true }).annotations({
    title: "refine model",
    description:
      "Model ID for the refine provider (e.g. gpt-5.3-codex-spark, grok-4.5, llama3.2). Unset: gpt-5.3-codex-spark for codex, the provider's own models otherwise.",
  }),
  refineEffort: Schema.optionalWith(Schema.Literal("minimal", "low", "medium", "high", "xhigh"), {
    exact: true,
  }).annotations({
    title: "refine effort",
    description: "Reasoning effort for providers that support it. Unset: low, so dictation refine stays fast.",
  }),
  refinePressEnter: withDefault(Schema.Boolean, false).annotations({
    title: "refine press Enter",
    description: "Press Enter after dictated text (refined or not) is typed at the caret.",
  }),
  refineSendTo: withDefault(refineSendToSchema, "caret").annotations({
    title: "refine send to",
    description:
      "Where refined dictation goes: caret (the focused input), cmux-new (a new focused cmux workspace), or cmux-resume (the focused cmux surface).",
  }),
  refineCmuxCommand: withDefault(trimmedText, "").annotations({
    title: "refine cmux command",
    description:
      "Shell command run in the new cmux workspace for cmux-new. Placeholders, each replaced by one shell-quoted word: {{prompt_file}}, {{prompt}}, {{cwd}}. Empty pastes the text only.",
  }),
  refineCmuxPressEnter: withDefault(Schema.Boolean, false).annotations({
    title: "refine cmux press Enter",
    description: "Press Enter after sending refined text into cmux (cmux-resume, or cmux-new without a command).",
  }),
});

export type Config = Schema.Schema.Type<typeof configSchema>;

type ConfigKey = keyof Config;

export const defaultConfig = Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({});

const decodeConfig = Schema.decodeUnknown(configSchema, { onExcessProperty: "error" });

type ConfigProperty = Schema.PropertySignature.All;

// The value side (before the default) carries the kind; the property signature carries title and description.
const propertyParts = (property: ConfigProperty): { valueAst: SchemaAST.AST; annotations: SchemaAST.Annotated } => {
  switch (property.ast._tag) {
    case "PropertySignatureDeclaration":
      return { valueAst: property.ast.type, annotations: property.ast };
    case "PropertySignatureTransformation":
      return { valueAst: property.ast.from.type, annotations: property.ast.to };
  }
};

type SettingKind = "number" | "boolean" | "text";

const settingKind = (valueAst: SchemaAST.AST): SettingKind => {
  switch (SchemaAST.encodedAST(valueAst)._tag) {
    case "NumberKeyword":
      return "number";
    case "BooleanKeyword":
      return "boolean";
    default:
      return "text";
  }
};

const unionMembers = (typeAst: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
  if (SchemaAST.isUnion(typeAst)) {
    return typeAst.types;
  }

  return [typeAst];
};

const literalChoices = (valueAst: SchemaAST.AST): ReadonlyArray<string> => {
  const typeAst = SchemaAST.typeAST(valueAst);
  if (SchemaAST.isBooleanKeyword(typeAst)) {
    return ["true", "false"];
  }

  const members = unionMembers(typeAst);
  return members.filter(SchemaAST.isLiteral).map((member) => String(member.literal));
};

// e.g. "speechWordsPerMinute" → "speech-words-per-minute"
const settingNameFor = (key: ConfigKey): string => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

type ConfigSetting = {
  readonly key: ConfigKey;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly kind: SettingKind;
  readonly choices: ReadonlyArray<string>;
  readonly optional: boolean;
};

const configFields = configSchema.fields;

export const configSettings: ReadonlyArray<ConfigSetting> = Struct.keys(configFields).map((key) => {
  const property: ConfigProperty = configFields[key];
  const { valueAst, annotations } = propertyParts(property);
  return {
    key,
    name: settingNameFor(key),
    label: SchemaAST.getTitleAnnotation(annotations).pipe(Option.getOrElse(() => key)),
    description: SchemaAST.getDescriptionAnnotation(annotations).pipe(Option.getOrElse(() => "")),
    kind: settingKind(valueAst),
    choices: literalChoices(valueAst),
    optional: property.ast._tag === "PropertySignatureDeclaration" && property.ast.isOptional,
  };
});

const decodeNumberText = Schema.decodeUnknown(Schema.NumberFromString);

const decodeBooleanText = Schema.decodeUnknown(Schema.BooleanFromString);

// Turn CLI text into the value a setting stores; empty text clears an optional setting.
export const settingValueFromText = (request: {
  readonly setting: ConfigSetting;
  readonly text: string;
}): Effect.Effect<Option.Option<unknown>, ParseResult.ParseError> => {
  const trimmed = request.text.trim();
  if (request.setting.optional && trimmed === "") {
    return Effect.succeedNone;
  }

  switch (request.setting.kind) {
    case "number":
      return decodeNumberText(trimmed).pipe(Effect.map(Option.some));
    case "boolean":
      return decodeBooleanText(trimmed).pipe(Effect.map(Option.some));
    case "text":
      return Effect.succeedSome(request.text);
  }
};

// A cleared optional setting leaves config.json without the key instead of storing an empty value.
export const withSettingValue = (request: {
  readonly config: Config;
  readonly key: ConfigKey;
  readonly value: Option.Option<unknown>;
}) => {
  const changedConfig = Option.match(request.value, {
    onNone: () => Struct.omit(request.config, request.key),
    onSome: (value) => ({ ...request.config, [request.key]: value }),
  });
  return decodeConfig(changedConfig);
};
