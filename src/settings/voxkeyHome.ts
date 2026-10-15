import { homedir } from "node:os";
import path from "node:path";

import { readEnvironment } from "./environmentVariables.js";

type StateFileName =
  | "status.json"
  | "seen.json"
  | "dictation.pid"
  | "dictation.lock"
  | "speech.pid"
  | "speech.lock"
  | "pill.pid"
  | "stop"
  | "dictation.log"
  | "dictation-worker.log"
  | "speech-worker.log"
  | "refine-choice.json"
  | "refine-codex-last-good.txt"
  | "refine-codex-failed.txt"
  | "created-hook-files.json";

type StateFolderName = "inbox" | "failed" | "models" | "backups" | "audio" | "prompts" | "devin";

export const voxkeyHome = (): string => {
  const { VOXKEY_HOME } = readEnvironment();
  if (VOXKEY_HOME !== "") {
    return path.resolve(VOXKEY_HOME);
  }

  const home = homedir();
  return path.join(home, ".voxkey");
};

const homePath = (name: string): string => {
  const home = voxkeyHome();
  return path.join(home, name);
};

export const configFilePath = (): string => {
  const { VOXKEY_CONFIG_FILE } = readEnvironment();
  if (VOXKEY_CONFIG_FILE !== "") {
    return path.resolve(VOXKEY_CONFIG_FILE);
  }

  return homePath("config.json");
};

export const stateFile = (name: StateFileName): string => homePath(name);

export const stateFolder = (name: StateFolderName): string => homePath(name);
