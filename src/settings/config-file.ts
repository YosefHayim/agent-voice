import { readTextIfPresent, writeFileAtomically } from "#src/storage/state-files.js";
import { configFilePath } from "./agent-voice-home.js";
import { type Config, decodeConfig, defaultConfig } from "./config-schema.js";

const readSavedText = (filePath: string): string | null => {
  try {
    return readTextIfPresent(filePath);
  } catch (error) {
    throw new Error(`${filePath} is not a valid agent-voice config: ${String(error)}`, { cause: error });
  }
};

const decodeSavedText = (request: { readonly filePath: string; readonly text: string }): Config => {
  try {
    return decodeConfig(JSON.parse(request.text));
  } catch (error) {
    const issue = error instanceof Error ? error.message : String(error);
    throw new Error(`${request.filePath} is not a valid agent-voice config: ${issue}`, { cause: error });
  }
};

// A file that cannot be read is an error, never the defaults, so `config set` never replaces it.
export const readConfig = (): Config => {
  const filePath = configFilePath();
  const savedFileContents = readSavedText(filePath);
  const isThereNoSavedFile = savedFileContents === null;
  if (isThereNoSavedFile) {
    return defaultConfig;
  }

  return decodeSavedText({ filePath, text: savedFileContents });
};

// Workers read the config on every decision; a broken file means defaults, never a crashed worker.
export const readConfigOrDefaults = (): Config => {
  try {
    return readConfig();
  } catch (error) {
    console.error({ error });
    return defaultConfig;
  }
};

export const saveConfig = (config: Config): void => {
  const savedFileContents = JSON.stringify(config, null, 2);
  writeFileAtomically({ path: configFilePath(), contents: `${savedFileContents}\n` });
};
