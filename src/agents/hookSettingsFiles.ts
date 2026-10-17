import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { type AgentHookTarget, agentHookTargets, agentIdSchema } from "./agentCatalog.js";

const hookSettingsFileSchema = Schema.Struct({
  agent: agentIdSchema,
  displayName: Schema.String,
  folder: Schema.String,
  file: Schema.String,
  ownFile: Schema.Boolean,
});

export type HookSettingsFile = Schema.Schema.Type<typeof hookSettingsFileSchema>;

const claudeEnvironmentSchema = Schema.Struct({
  CLAUDE_CONFIG_DIR: Schema.optionalWith(Schema.Trim, { default: () => "" }),
});

const CLAUDE_ACCOUNT_FOLDER = /^\.claude-./u;

// Claude Code writes .claude.json into every config folder it runs with.
const isClaudeConfigFolder = (folder: string): boolean => {
  const stateFile = path.join(folder, ".claude.json");
  const settingsFile = path.join(folder, "settings.json");
  return existsSync(stateFile) || existsSync(settingsFile);
};

const configuredClaudeFolders = (): ReadonlyArray<string> => {
  const environment = Schema.decodeUnknownSync(claudeEnvironmentSchema)(process.env);
  if (environment.CLAUDE_CONFIG_DIR === "") {
    return [];
  }

  return [path.resolve(environment.CLAUDE_CONFIG_DIR)];
};

// Claude Code reads ~/.claude unless CLAUDE_CONFIG_DIR names another folder, so each extra account is its own
// ~/.claude-<name> folder with its own settings.json.
const claudeConfigFolders = (defaultFolder: string): ReadonlyArray<string> => {
  const home = homedir();
  const accountFolders = readdirSync(home)
    .filter((name) => CLAUDE_ACCOUNT_FOLDER.test(name))
    .map((name) => path.join(home, name))
    .filter(isClaudeConfigFolder);
  const configuredFolders = configuredClaudeFolders();
  const folders = new Set([defaultFolder, ...accountFolders, ...configuredFolders]);
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
