import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import { describeError } from "#src/error-message.js";
import { stateFile, stateFolder } from "#src/settings/agent-voice-home.js";
import { makePrivateFolder, readJsonFile, readTextIfPresent, writeJsonAtomically } from "#src/storage/state-files.js";
import { agentVoiceInvocation } from "#src/workers/worker-processes.js";
import type { AgentId } from "./agent-catalog.js";
import { addReplyHook, isEmptySettings, removeReplyHook, replyHookCommand } from "./hook-settings.js";
import { type HookSettingsFile, hookSettingsFiles, rememberClaudeConfigFolder } from "./hook-settings-files.js";

export type HookChangeKind = "added" | "unchanged" | "removed" | "absent" | "not installed" | "failed";

export interface HookChange {
  readonly agent: AgentId;
  readonly displayName: string;
  readonly file: string;
  readonly change: HookChangeKind;
  readonly backup?: string;
  readonly issue?: string;
}

const createdFilesSchema = z.array(z.string());

const isAgentInstalled = (settings: HookSettingsFile): boolean => existsSync(settings.folder);

// The folder's name and a hash of its path are in the backup name, so two Claude Code folders backed up in the same
// millisecond keep both copies, even when both are called .claude.
const folderTag = (folder: string): string => {
  const name = path.basename(folder).replace(/^\./u, "");
  const pathHash = createHash("sha256").update(folder).digest("hex").slice(0, 8);
  return `${name}-${pathHash}`;
};

const backupFile = (settings: HookSettingsFile): string => {
  // Agent settings can hold tokens, so their copies are private like the rest of agent-voice's state.
  const folder = stateFolder("backups");
  makePrivateFolder(folder);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const agentFolder = folderTag(settings.folder);
  const settingsName = path.basename(settings.file);
  const backup = path.join(folder, `${settings.agent}-${agentFolder}-${settingsName}-${stamp}`);
  copyFileSync(settings.file, backup);
  chmodSync(backup, 0o600);
  return backup;
};

const fileMode = (file: string): number => {
  const isFileAbsent = !existsSync(file);
  if (isFileAbsent) {
    return 0o644;
  }

  return statSync(file).mode & 0o777;
};

// The agent's file keeps its permissions; the new text lands through a rename so the agent never reads half of it.
const writeSettings = (settings: HookSettingsFile, text: string): void => {
  const file = settings.file;
  const mode = fileMode(file);
  const folder = path.dirname(file);
  mkdirSync(folder, { recursive: true });
  const staging = `${file}.agent-voice-partial`;
  writeFileSync(staging, text, { mode });
  renameSync(staging, file);
};

// Settings files agent-voice created, so `agent-voice off` can delete one it leaves empty and keep any file that existed before.
const createdFiles = (): ReadonlyArray<string> => {
  const createdPath = stateFile("created-hook-files.json");
  return readJsonFile({ path: createdPath, schema: createdFilesSchema }) ?? [];
};

const recordCreated = (request: { readonly file: string; readonly created: boolean }): void => {
  const createdPath = stateFile("created-hook-files.json");
  const others = createdFiles().filter((file) => file !== request.file);

  if (request.created) {
    writeJsonAtomically({ path: createdPath, value: [...others, request.file] });
    return;
  }

  writeJsonAtomically({ path: createdPath, value: others });
};

const changeFor = (settings: HookSettingsFile, change: HookChangeKind): HookChange => ({
  agent: settings.agent,
  displayName: settings.displayName,
  file: settings.file,
  change,
});

// A settings file agent-voice cannot read or parse is reported and left exactly as it is.
const failedChange = (settings: HookSettingsFile, error: unknown): HookChange => ({
  ...changeFor(settings, "failed"),
  issue: describeError(error),
});

// Reading an unreadable file as missing would replace the user's settings with a hook-only file.
const readSettings = (settings: HookSettingsFile): string | null => {
  try {
    return readTextIfPresent(settings.file);
  } catch (error) {
    throw new Error(`the settings file could not be read (${String(error)})`, { cause: error });
  }
};

const agentVoiceReplyCommand = (settings: HookSettingsFile): string => {
  const invocation = agentVoiceInvocation();
  return replyHookCommand({
    nodePath: invocation.executable,
    scriptArguments: invocation.scriptArguments,
    agent: settings.agent,
  });
};

// A settings file agent-voice created is deleted once its entry was the only thing in it.
const saveRemoval = (settings: HookSettingsFile, source: string): void => {
  const isCreatedByAgentVoice = settings.ownFile || createdFiles().includes(settings.file);

  const isEmptyAgentVoiceSettings = isCreatedByAgentVoice && isEmptySettings(source);
  if (isEmptyAgentVoiceSettings) {
    rmSync(settings.file, { force: true });
    return;
  }

  writeSettings(settings, source);
};

const registerInstalled = (settings: HookSettingsFile): HookChange => {
  const current = readSettings(settings);
  const source = current ?? "";
  const command = agentVoiceReplyCommand(settings);
  const edit = addReplyHook({ source, command, agent: settings.agent });

  const isEditUnchanged = !edit.changed;
  if (isEditUnchanged) {
    return changeFor(settings, "unchanged");
  }

  const added = changeFor(settings, "added");

  const isNewSettingsFile = current === null;
  if (isNewSettingsFile) {
    writeSettings(settings, edit.source);
    recordCreated({ file: added.file, created: true });
    return added;
  }

  const backup = backupFile(settings);
  writeSettings(settings, edit.source);
  return { ...added, backup };
};

const registerOne = (settings: HookSettingsFile): HookChange => {
  const isNotInstalled = !isAgentInstalled(settings);
  if (isNotInstalled) {
    return changeFor(settings, "not installed");
  }

  try {
    return registerInstalled(settings);
  } catch (error) {
    return failedChange(settings, error);
  }
};

const unregisterInstalled = (settings: HookSettingsFile): HookChange => {
  const current = readSettings(settings);

  const isThereNoSettingsText = current === null;
  if (isThereNoSettingsText) {
    return changeFor(settings, "absent");
  }

  const edit = removeReplyHook({ source: current, agent: settings.agent });

  const isEditUnchanged = !edit.changed;
  if (isEditUnchanged) {
    return changeFor(settings, "absent");
  }

  const backup = backupFile(settings);
  const removed = changeFor(settings, "removed");
  saveRemoval(settings, edit.source);
  recordCreated({ file: removed.file, created: false });
  return { ...removed, backup };
};

const unregisterOne = (settings: HookSettingsFile): HookChange => {
  try {
    return unregisterInstalled(settings);
  } catch (error) {
    return failedChange(settings, error);
  }
};

export const registerReplyHooks = (): ReadonlyArray<HookChange> => {
  rememberClaudeConfigFolder();
  return hookSettingsFiles().map(registerOne);
};

export const unregisterReplyHooks = (): ReadonlyArray<HookChange> => hookSettingsFiles().map(unregisterOne);

// A file that cannot be read or parsed is shown on stderr and left off the list; registering reports it as failed.
const hasReplyHook = (settings: HookSettingsFile): boolean => {
  try {
    const current = readSettings(settings);

    const isThereNoSettingsText = current === null;
    if (isThereNoSettingsText) {
      return false;
    }

    return removeReplyHook({ source: current, agent: settings.agent }).changed;
  } catch (error) {
    console.error({ settingsFile: settings.file, error });
    return false;
  }
};

export const registeredSettingsFiles = (): ReadonlyArray<HookSettingsFile> => hookSettingsFiles().filter(hasReplyHook);
