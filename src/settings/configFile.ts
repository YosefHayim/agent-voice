/** Read and write voxkey's config.json; the file holds only the settings in configSchema. */

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

const decodeConfigText = Schema.decodeUnknownEither(Schema.parseJson(configSchema), { onExcessProperty: "error" });

/** The saved config, or the defaults when no file exists yet; a file that cannot be read is an error, never the defaults. */
export const readConfig: Effect.Effect<Config, ConfigFileError> = Effect.suspend(() => {
  const filePath = configFilePath();
  const saved = Effect.try({
    try: () => readTextIfPresent(filePath),
    catch: (error) => new ConfigFileError({ path: filePath, issue: String(error) }),
  });
  return Effect.flatMap(
    saved,
    Option.match({
      onNone: () => Effect.succeed(defaultConfig),
      onSome: (text) =>
        Effect.mapError(
          decodeConfigText(text),
          (error) => new ConfigFileError({ path: filePath, issue: ParseResult.TreeFormatter.formatErrorSync(error) }),
        ),
    }),
  );
});

/** Workers read the config on every decision; a broken file means defaults, never a crashed worker. */
export const readConfigOrDefaults: Effect.Effect<Config> = Effect.orElseSucceed(readConfig, () => defaultConfig);

export const saveConfig = (config: Config): Effect.Effect<void, ConfigFileError> =>
  Effect.try({
    try: () =>
      writeFileAtomically({
        path: configFilePath(),
        text: `${JSON.stringify(Schema.encodeSync(configSchema)(config), null, 2)}\n`,
      }),
    catch: (error) => new ConfigFileError({ path: configFilePath(), issue: String(error) }),
  });
