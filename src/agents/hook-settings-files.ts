import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { readStatusFile } from "#src/settings/agent-voice-home.js";
import { readDocumentFile, writeDocumentAtomically } from "#src/storage/state-files.js";
import { type AgentHookTarget, type AgentId, agentHookTargets } from "./agent-catalog.js";

const CLAUDE_FOLDERS_STATUS_FILE = "claude-config-folders.json";

export interface HookSettingsFile {
  readonly agent: AgentId;
  readonly displayName: string;
  readonly folder: string;
  readonly file: string;
  readonly ownFile: boolean;
}

const claudeSettingsFoldersSchema = z.array(z.string());

// Claude Code writes .claude.json into every config folder it runs with.
const isClaudeSettingsFolder = (folder: string): boolean => {
  const statusFilePath = path.join(folder, ".claude.json");
  const settingsFile = path.join(folder, "settings.json");
  return existsSync(statusFilePath) || existsSync(settingsFile);
};

const listConfiguredClaudeFolders = (): ReadonlyArray<string> => {
  const claudeSettingsDirectory = (process.env.CLAUDE_CONFIG_DIR ?? "").trim();

  const isClaudeDirectoryEmpty = claudeSettingsDirectory === "";
  if (isClaudeDirectoryEmpty) {
    return [];
  }

  return [path.resolve(claudeSettingsDirectory)];
};

const listRememberedClaudeFolders = (): ReadonlyArray<string> => {
  const foldersPath = readStatusFile(CLAUDE_FOLDERS_STATUS_FILE);
  const remembered = readDocumentFile({ path: foldersPath, schema: claudeSettingsFoldersSchema }) ?? [];
  return remembered.filter((folder) => existsSync(folder));
};

// `off` may run without CLAUDE_CONFIG_DIR, so the folder it named when the hook was added is kept here.
export const rememberClaudeSettingsFolder = (): void => {
  const remembered = listRememberedClaudeFolders();
  const newFolders = listConfiguredClaudeFolders().filter((folder) => !remembered.includes(folder));

  const isNewFoldersEmpty = newFolders.length === 0;
  if (isNewFoldersEmpty) {
    return;
  }

  const foldersPath = readStatusFile(CLAUDE_FOLDERS_STATUS_FILE);
  writeDocumentAtomically({ path: foldersPath, value: [...remembered, ...newFolders] });
};

// Claude Code reads ~/.claude unless CLAUDE_CONFIG_DIR names another folder, so each extra account is its own
// ~/.claude-<name> folder with its own settings.json.
const listClaudeSettingsFolders = (defaultFolder: string): ReadonlyArray<string> => {
  const home = homedir();
  const accountFolders = readdirSync(home)
    .filter((name) => /^\.claude-./u.test(name))
    .map((name) => path.join(home, name))
    .filter(isClaudeSettingsFolder);
  const rememberedFolders = listRememberedClaudeFolders();
  const configuredFolders = listConfiguredClaudeFolders();
  const folders = new Set([defaultFolder, ...accountFolders, ...rememberedFolders, ...configuredFolders]);

  return [...folders];
};

const listAgentFolders = (target: AgentHookTarget): ReadonlyArray<string> => {
  const home = homedir();
  const defaultFolder = path.join(home, target.homeFolder);

  const isNotClaudeCode = target.agent !== "claude-code";
  if (isNotClaudeCode) {
    return [defaultFolder];
  }

  return listClaudeSettingsFolders(defaultFolder);
};

// One file per agent folder: Claude Code can have several, every other agent has one.
export const listHookSettingsFiles = (): ReadonlyArray<HookSettingsFile> =>
  agentHookTargets.flatMap((target) => {
    const folders = listAgentFolders(target);

    return folders.map((folder) => ({
      agent: target.agent,
      displayName: target.displayName,
      folder,
      file: path.join(folder, target.settingsFile),
      ownFile: target.ownFile,
    }));
  });
