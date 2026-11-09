import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { stateFile } from "#src/settings/agent-voice-home.js";
import { readJsonFile, writeJsonAtomically } from "#src/storage/state-files.js";
import { type AgentHookTarget, type AgentId, agentHookTargets } from "./agent-catalog.js";

export interface HookSettingsFile {
  readonly agent: AgentId;
  readonly displayName: string;
  readonly folder: string;
  readonly file: string;
  readonly ownFile: boolean;
}

const claudeConfigFoldersSchema = z.array(z.string());

const CLAUDE_ACCOUNT_FOLDER = /^\.claude-./u;

// Claude Code writes .claude.json into every config folder it runs with.
const isClaudeConfigFolder = (folder: string): boolean => {
  const stateFilePath = path.join(folder, ".claude.json");
  const settingsFile = path.join(folder, "settings.json");
  return existsSync(stateFilePath) || existsSync(settingsFile);
};

const configuredClaudeFolders = (): ReadonlyArray<string> => {
  const claudeConfigDirectory = (process.env.CLAUDE_CONFIG_DIR ?? "").trim();
  if (claudeConfigDirectory === "") {
    return [];
  }

  return [path.resolve(claudeConfigDirectory)];
};

const rememberedClaudeFolders = (): ReadonlyArray<string> => {
  const foldersPath = stateFile("claude-config-folders.json");
  const remembered = readJsonFile({ path: foldersPath, schema: claudeConfigFoldersSchema }) ?? [];
  return remembered.filter((folder) => existsSync(folder));
};

// `off` may run without CLAUDE_CONFIG_DIR, so the folder it named when the hook was added is kept here.
export const rememberClaudeConfigFolder = (): void => {
  const remembered = rememberedClaudeFolders();
  const newFolders = configuredClaudeFolders().filter((folder) => !remembered.includes(folder));
  if (newFolders.length === 0) {
    return;
  }

  const foldersPath = stateFile("claude-config-folders.json");
  writeJsonAtomically({ path: foldersPath, value: [...remembered, ...newFolders] });
};

// Claude Code reads ~/.claude unless CLAUDE_CONFIG_DIR names another folder, so each extra account is its own
// ~/.claude-<name> folder with its own settings.json.
const claudeConfigFolders = (defaultFolder: string): ReadonlyArray<string> => {
  const home = homedir();
  const accountFolders = readdirSync(home)
    .filter((name) => CLAUDE_ACCOUNT_FOLDER.test(name))
    .map((name) => path.join(home, name))
    .filter(isClaudeConfigFolder);
  const rememberedFolders = rememberedClaudeFolders();
  const configuredFolders = configuredClaudeFolders();
  const folders = new Set([defaultFolder, ...accountFolders, ...rememberedFolders, ...configuredFolders]);
  return [...folders];
};

const agentFolders = (target: AgentHookTarget): ReadonlyArray<string> => {
  const home = homedir();
  const defaultFolder = path.join(home, target.homeFolder);
  const isClaudeCode = target.agent === "claude-code";
  if (!isClaudeCode) {
    return [defaultFolder];
  }

  return claudeConfigFolders(defaultFolder);
};

// One file per agent folder: Claude Code can have several, every other agent has one.
export const hookSettingsFiles = (): ReadonlyArray<HookSettingsFile> =>
  agentHookTargets.flatMap((target) => {
    const folders = agentFolders(target);
    return folders.map((folder) => ({
      agent: target.agent,
      displayName: target.displayName,
      folder,
      file: path.join(folder, target.settingsFile),
      ownFile: target.ownFile,
    }));
  });
