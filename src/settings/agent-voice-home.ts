import { homedir } from "node:os";
import path from "node:path";

import { readEnvironment } from "./environment-variables.js";

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
  | "created-hook-files.json"
  | "claude-config-folders.json";

type StateFolderName = "inbox" | "failed" | "models" | "backups" | "audio" | "prompts" | "devin";

export const readAgentVoiceHome = (): string => {
  const { AGENT_VOICE_HOME } = readEnvironment();

  const isHomeSet = AGENT_VOICE_HOME !== "";
  if (isHomeSet) {
    return path.resolve(AGENT_VOICE_HOME);
  }

  const home = homedir();
  return path.join(home, ".agent-voice");
};

const readHomePath = (name: string): string => {
  const home = readAgentVoiceHome();
  return path.join(home, name);
};

export const readConfigFilePath = (): string => {
  const { AGENT_VOICE_CONFIG_FILE } = readEnvironment();

  const isConfigFileSet = AGENT_VOICE_CONFIG_FILE !== "";
  if (isConfigFileSet) {
    return path.resolve(AGENT_VOICE_CONFIG_FILE);
  }

  return readHomePath("config.json");
};

export const readStateFile = (name: StateFileName): string => readHomePath(name);

export const readStateFolder = (name: StateFolderName): string => readHomePath(name);
