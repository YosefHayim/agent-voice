import { readTextIfPresent, writeFileAtomically } from "#src/storage/state-files.js";
import { readConfigFilePath } from "./agent-voice-home.js";
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
    const isErrorInstanceError = error instanceof Error;
    const issue = isErrorInstanceError ? error.message : String(error);
    throw new Error(`${request.filePath} is not a valid agent-voice config: ${issue}`, { cause: error });
  }
};

// A file that cannot be read is an error, never the defaults, so `config set` never replaces it.
export const readConfig = (): Config => {
  const filePath = readConfigFilePath();
  const savedFileContents = readSavedText(filePath);

  const isThereNoSavedFile = savedFileContents === null;
  if (isThereNoSavedFile) {
    return defaultConfig;
  }

  return decodeSavedText({ filePath, text: savedFileContents });
};

// A broken file is a reading the caller checks, so the Stop hook can stay silent while workers log it.
type ConfigFileReading =
  | { readonly status: "read"; readonly config: Config }
  | { readonly status: "broken"; readonly issue: string };

export const readConfigFileReading = (): ConfigFileReading => {
  try {
    const config = readConfig();
    return { status: "read", config };
  } catch (error) {
    const isErrorInstance = error instanceof Error;
    const issue = isErrorInstance ? error.message : String(error);
    return { status: "broken", issue };
  }
};

// Each distinct broken-config message is logged once per process, since workers read the config often.
const loggedConfigIssues = new Set<string>();

// Workers read the config on every decision; a broken file means defaults, never a crashed worker.
export const readConfigOrDefaults = (): Config => {
  const configFileReading = readConfigFileReading();
  const isConfigFileRead = configFileReading.status === "read";
  if (isConfigFileRead) {
    return configFileReading.config;
  }

  const isIssueNew = !loggedConfigIssues.has(configFileReading.issue);

  if (isIssueNew) {
    loggedConfigIssues.add(configFileReading.issue);
    console.error({ issue: configFileReading.issue });
  }

  return defaultConfig;
};

export const saveConfig = (config: Config): void => {
  const savedFileContents = JSON.stringify(config, null, 2);
  writeFileAtomically({ path: readConfigFilePath(), contents: `${savedFileContents}\n` });
};
