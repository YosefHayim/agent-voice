import { readFileIfExists, writeFileAtomically } from "#src/storage/state-files.js";
import { readSettingsFilePath } from "./agent-voice-home.js";
import { decodeSettings, defaultSettings, type Settings } from "./config-schema.js";

const readSavedFile = (filePath: string): string | null => {
  try {
    return readFileIfExists(filePath);
  } catch (error) {
    throw new Error(`${filePath} is not a valid agent-voice config: ${String(error)}`, { cause: error });
  }
};

const decodeSavedSettings = (request: { readonly filePath: string; readonly text: string }): Settings => {
  try {
    return decodeSettings(JSON.parse(request.text));
  } catch (error) {
    const isErrorInstanceError = error instanceof Error;
    const issue = isErrorInstanceError ? error.message : String(error);
    throw new Error(`${request.filePath} is not a valid agent-voice config: ${issue}`, { cause: error });
  }
};

// A file that cannot be read is an error, never the defaults, so `config set` never replaces it.
export const readSettings = (): Settings => {
  const filePath = readSettingsFilePath();
  const savedFileMessages = readSavedFile(filePath);

  const isThereNoSavedFile = savedFileMessages == null;
  if (isThereNoSavedFile) {
    return defaultSettings;
  }

  return decodeSavedSettings({ filePath, text: savedFileMessages });
};

// A broken file is a reading the caller checks, so the Stop hook can stay silent while workers log it.
type SettingsFileReading =
  | { readonly status: "read"; readonly config: Settings }
  | { readonly status: "broken"; readonly issue: string };

export const readSettingsFileReading = (): SettingsFileReading => {
  try {
    const settings = readSettings();
    return { status: "read", config: settings };
  } catch (error) {
    const isErrorInstance = error instanceof Error;
    const issue = isErrorInstance ? error.message : String(error);
    return { status: "broken", issue };
  }
};

// Each distinct broken-config message is logged once per process, since workers read the config often.
const loggedSettingsIssues = new Set<string>();

// Workers read the config on every decision; a broken file means defaults, never a crashed worker.
export const readSettingsOrDefaults = (): Settings => {
  const settingsFileReading = readSettingsFileReading();
  const isSettingsFileRead = settingsFileReading.status === "read";
  if (isSettingsFileRead) {
    return settingsFileReading.config;
  }

  const isIssueNew = !loggedSettingsIssues.has(settingsFileReading.issue);

  if (isIssueNew) {
    loggedSettingsIssues.add(settingsFileReading.issue);
    console.error({ issue: settingsFileReading.issue });
  }

  return defaultSettings;
};

export const saveSettings = (settings: Settings): void => {
  const savedFileMessages = JSON.stringify(settings, null, 2);
  writeFileAtomically({ path: readSettingsFilePath(), contents: `${savedFileMessages}\n` });
};
