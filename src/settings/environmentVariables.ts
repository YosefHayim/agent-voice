import { Option, Schema, SchemaAST } from "effect";

// "off", "0", "false", and "no" switch a feature off; anything else (or unset) leaves it on.
const OFF_WORDS = ["0", "false", "off", "no"];

const isSwitchOn = (text: string): boolean => {
  const word = text.trim().toLowerCase();
  return !OFF_WORDS.includes(word);
};

const switchSchema = Schema.transform(Schema.String, Schema.Boolean, {
  strict: true,
  decode: isSwitchOn,
  encode: String,
});

const textVariable = Schema.optionalWith(Schema.Trim, { default: () => "" });

const switchVariable = Schema.optionalWith(switchSchema, { default: () => true });

const environmentSchema = Schema.Struct({
  AGENT_VOICE_HOME: textVariable.annotations({
    description: "Folder for agent-voice's config, state, models, and logs. Default: ~/.agent-voice.",
  }),
  AGENT_VOICE_CONFIG_FILE: textVariable.annotations({
    description:
      "Path to the config file. When set, it is the only config file read. Default: $AGENT_VOICE_HOME/config.json.",
  }),
  AGENT_VOICE_DICTATION_MODEL: textVariable.annotations({
    description:
      "Forces the Whisper model: turbo-q5, turbo-q8, turbo, small, base, tiny, or ivrit. Overrides the dictation-model setting. Default: unset.",
  }),
  AGENT_VOICE_DICTATION_LIVE_PREVIEW: switchVariable.annotations({
    description: "Set to off (or 0, false, no) to stop the live caption while Shift is held. Default: on.",
  }),
  AGENT_VOICE_REFINE_PICKER: switchVariable.annotations({
    description:
      "Set to off (or 0, false, no) so a failed refine never opens the macOS model picker (CI, headless Macs). Default: on.",
  }),
  CI: textVariable.annotations({
    description: "Set by CI services; any value turns the refine picker off.",
  }),
});

export type AgentVoiceEnvironment = Schema.Schema.Type<typeof environmentSchema>;

const decodeEnvironment = Schema.decodeUnknownSync(environmentSchema);

export const readEnvironment = (): AgentVoiceEnvironment => decodeEnvironment(process.env);

const environmentTypeAst = SchemaAST.typeAST(environmentSchema.ast);

// README and .env.example list exactly these: agent-voice's own variables, not CI.
export const agentVoiceVariables = SchemaAST.getPropertySignatures(environmentTypeAst)
  .map((field) => ({
    name: String(field.name),
    description: SchemaAST.getDescriptionAnnotation(field).pipe(Option.getOrElse(() => "")),
  }))
  .filter((variable) => variable.name.startsWith("AGENT_VOICE_"));
