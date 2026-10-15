import { Effect, Option, ParseResult, Schema } from "effect";

import { readTextIfPresent, writeFileAtomically } from "../files/stateFiles.js";
import { type Config, configSchema, defaultConfig } from "./configSchema.js";
import { configFilePath } from "./voxkeyHome.js";

export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  issue: Schema.String,
}) {
  get message(): string {
    return `${this.path} is not a valid voxkey config: ${this.issue}`;
  }
}

const decodeConfigText = Schema.decodeUnknown(Schema.parseJson(configSchema), { onExcessProperty: "error" });

const encodeConfig = Schema.encodeSync(configSchema);

// A file that cannot be read is an error, never the defaults, so `config set` never replaces it.
export const readConfig: Effect.Effect<Config, ConfigFileError> = Effect.gen(function* () {
  const filePath = configFilePath();
  const savedText = yield* Effect.try({
    try: () => readTextIfPresent(filePath),
    catch: (error) => new ConfigFileError({ path: filePath, issue: String(error) }),
  });
  if (Option.isNone(savedText)) {
    return defaultConfig;
  }

  return yield* decodeConfigText(savedText.value).pipe(
    Effect.mapError(
      (error) => new ConfigFileError({ path: filePath, issue: ParseResult.TreeFormatter.formatErrorSync(error) }),
    ),
  );
});

// Workers read the config on every decision; a broken file means defaults, never a crashed worker.
export const readConfigOrDefaults: Effect.Effect<Config> = Effect.orElseSucceed(readConfig, () => defaultConfig);

export const saveConfig = (config: Config): Effect.Effect<void, ConfigFileError> => {
  const filePath = configFilePath();
  return Effect.try({
    try: () => {
      const savedConfig = encodeConfig(config);
      const text = JSON.stringify(savedConfig, null, 2);
      writeFileAtomically({ path: filePath, text: `${text}\n` });
    },
    catch: (error) => new ConfigFileError({ path: filePath, issue: String(error) }),
  });
};
