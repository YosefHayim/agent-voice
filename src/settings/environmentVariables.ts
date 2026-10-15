/** Every VOXKEY_* environment variable, decoded once from process.env. */

import { Schema } from "effect";

// "off", "0", "false", and "no" switch a feature off; anything else (or unset) leaves it on.
const switchSchema = Schema.transform(Schema.String, Schema.Boolean, {
  strict: true,
  decode: (text) => !["0", "false", "off", "no"].includes(text.trim().toLowerCase()),
  encode: (enabled) => (enabled ? "on" : "off"),
});

const textVariable = Schema.optionalWith(Schema.Trim, { default: () => "" });

const switchVariable = Schema.optionalWith(switchSchema, { default: () => true });

const environmentSchema = Schema.Struct({
  VOXKEY_HOME: textVariable.annotations({
    description: "Folder for voxkey's config, state, models, and logs. Default: ~/.voxkey.",
  }),
  VOXKEY_CONFIG_FILE: textVariable.annotations({
    description:
      "Path to the config file. When set, it is the only config file read. Default: $VOXKEY_HOME/config.json.",
  }),
  VOXKEY_DICTATION_MODEL: textVariable.annotations({
    description:
      "Forces the Whisper model: turbo-q5, turbo-q8, turbo, small, base, tiny, or ivrit. Default: dictation-language picks turbo-q5 or ivrit.",
  }),
  VOXKEY_DICTATION_LIVE_PREVIEW: switchVariable.annotations({
    description: "Set to off (or 0, false, no) to stop the live caption while Shift is held. Default: on.",
  }),
  VOXKEY_REFINE_PICKER: switchVariable.annotations({
    description:
      "Set to off (or 0, false, no) so a failed refine never opens the macOS model picker (CI, headless Macs). Default: on.",
  }),
  CI: textVariable.annotations({
    description: "Set by CI services; any value turns the refine picker off.",
  }),
});

export type VoxkeyEnvironment = Schema.Schema.Type<typeof environmentSchema>;

export const readEnvironment = (): VoxkeyEnvironment => Schema.decodeUnknownSync(environmentSchema)(process.env);

// The README lists exactly these names; voxkey's own variables only, not CI.
export const environmentVariableNames = Object.keys(environmentSchema.fields).filter((name) =>
  name.startsWith("VOXKEY_"),
);
