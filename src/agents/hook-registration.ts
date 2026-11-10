import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import { describeError } from "#src/error-message.js";
import { readStatusFile, readStatusFolder } from "#src/settings/agent-voice-home.js";
import {
  makePrivateFolder,
  readDocumentFile,
  readFileIfExists,
  writeDocumentAtomically,
} from "#src/storage/state-files.js";
import { readAgentVoiceInvocation } from "#src/workers/worker-processes.js";
import type { AgentId } from "./agent-catalog.js";
import { addReplyHook, isEmptySettings, removeReplyHook, replyHookCommand } from "./hook-settings.js";
import { type HookSettingsFile, listHookSettingsFiles, rememberClaudeSettingsFolder } from "./hook-settings-files.js";

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
const readFolderTag = (folder: string): string => {
  const name = path.basename(folder).replace(/^\./u, "");
  const pathHash = createHash("sha256").update(folder).digest("hex").slice(0, 8);
  return `${name}-${pathHash}`;
};

const readBackupFile = (settings: HookSettingsFile): string => {
  // Agent settings can hold tokens, so their copies are private like the rest of agent-voice's state.
  const folder = readStatusFolder("backups");
  makePrivateFolder(folder);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const agentFolder = readFolderTag(settings.folder);
  const settingsName = path.basename(settings.file);
  const backup = path.join(folder, `${settings.agent}-${agentFolder}-${settingsName}-${stamp}`);
  copyFileSync(settings.file, backup);
  chmodSync(backup, 0o600);
  return backup;
};

const readFileMode = (file: string): number => {
  const isFileAbsent = !existsSync(file);
  if (isFileAbsent) {
    return 0o644;
  }

  return statSync(file).mode & 0o777;
};

// The agent's file keeps its permissions; the new text lands through a rename so the agent never reads half of it.
const writeSettings = (settings: HookSettingsFile, string: string): void => {
  const file = settings.file;
  const mode = readFileMode(file);
  const folder = path.dirname(file);
  mkdirSync(folder, { recursive: true });
  const staging = `${file}.agent-voice-partial`;
  writeFileSync(staging, string, { mode });
  renameSync(staging, file);
};

// Settings files agent-voice created, so `agent-voice off` can delete one it leaves empty and keep any file that existed before.
const listCreatedFiles = (): ReadonlyArray<string> => {
  const createdPath = readStatusFile("created-hook-files.json");
  return readDocumentFile({ path: createdPath, schema: createdFilesSchema }) ?? [];
};

const saveCreated = (request: { readonly file: string; readonly created: boolean }): void => {
  const createdPath = readStatusFile("created-hook-files.json");
  const others = listCreatedFiles().filter((file) => file !== request.file);

  if (request.created) {
    writeDocumentAtomically({ path: createdPath, value: [...others, request.file] });
    return;
  }

  writeDocumentAtomically({ path: createdPath, value: others });
};

const readHookChange = (settings: HookSettingsFile, change: HookChangeKind): HookChange => ({
  agent: settings.agent,
  displayName: settings.displayName,
  file: settings.file,
  change,
});

// A settings file agent-voice cannot read or parse is reported and left exactly as it is.
const readFailedChange = (settings: HookSettingsFile, error: unknown): HookChange => ({
  ...readHookChange(settings, "failed"),
  issue: describeError(error),
});

// Reading an unreadable file as missing would replace the user's settings with a hook-only file.
const readSettings = (settings: HookSettingsFile): string | null => {
  try {
    return readFileIfExists(settings.file);
  } catch (error) {
    throw new Error(`the settings file could not be read (${String(error)})`, { cause: error });
  }
};

const readAgentVoiceReplyCommand = (settings: HookSettingsFile): string => {
  const invocation = readAgentVoiceInvocation();
  return replyHookCommand({
    nodePath: invocation.executable,
    scriptArguments: invocation.scriptArguments,
    agent: settings.agent,
  });
};

// A settings file agent-voice created is deleted once its entry was the only thing in it.
const saveRemoval = (settings: HookSettingsFile, code: string): void => {
  const isCreatedByAgentVoice = settings.ownFile || listCreatedFiles().includes(settings.file);

  const isEmptyAgentVoiceSettings = isCreatedByAgentVoice && isEmptySettings(code);
  if (isEmptyAgentVoiceSettings) {
    rmSync(settings.file, { force: true });
    return;
  }

  writeSettings(settings, code);
};

const registerInstalled = (settings: HookSettingsFile): HookChange => {
  const current = readSettings(settings);
  const code = current ?? "";
  const command = readAgentVoiceReplyCommand(settings);
  const edit = addReplyHook({ source: code, command, agent: settings.agent });

  const isEditUnchanged = !edit.changed;
  if (isEditUnchanged) {
    return readHookChange(settings, "unchanged");
  }

  const added = readHookChange(settings, "added");

  const isNewSettingsFile = current == null;
  if (isNewSettingsFile) {
    writeSettings(settings, edit.source);
    saveCreated({ file: added.file, created: true });
    return added;
  }

  const backup = readBackupFile(settings);
  writeSettings(settings, edit.source);
  return { ...added, backup };
};

const registerOne = (settings: HookSettingsFile): HookChange => {
  const isNotInstalled = !isAgentInstalled(settings);
  if (isNotInstalled) {
    return readHookChange(settings, "not installed");
  }

  try {
    return registerInstalled(settings);
  } catch (error) {
    return readFailedChange(settings, error);
  }
};

const unregisterInstalled = (settings: HookSettingsFile): HookChange => {
  const current = readSettings(settings);

  const isSettingsFileMissing = current == null;
  if (isSettingsFileMissing) {
    return readHookChange(settings, "absent");
  }

  const edit = removeReplyHook({ source: current, agent: settings.agent });

  const isEditUnchanged = !edit.changed;
  if (isEditUnchanged) {
    return readHookChange(settings, "absent");
  }

  const backup = readBackupFile(settings);
  const removed = readHookChange(settings, "removed");
  saveRemoval(settings, edit.source);
  saveCreated({ file: removed.file, created: false });
  return { ...removed, backup };
};

const unregisterOne = (settings: HookSettingsFile): HookChange => {
  try {
    return unregisterInstalled(settings);
  } catch (error) {
    return readFailedChange(settings, error);
  }
};

export const registerReplyHooks = (): ReadonlyArray<HookChange> => {
  rememberClaudeSettingsFolder();
  return listHookSettingsFiles().map(registerOne);
};

export const unregisterReplyHooks = (): ReadonlyArray<HookChange> => listHookSettingsFiles().map(unregisterOne);

// A file that cannot be read or parsed is shown on stderr and left off the list; registering reports it as failed.
const hasReplyHook = (settings: HookSettingsFile): boolean => {
  try {
    const current = readSettings(settings);

    const isSettingsFileMissing = current == null;
    if (isSettingsFileMissing) {
      return false;
    }

    return removeReplyHook({ source: current, agent: settings.agent }).changed;
  } catch (error) {
    console.error({ settingsFile: settings.file, error });
    return false;
  }
};

export const listRegisteredSettingsFiles = (): ReadonlyArray<HookSettingsFile> =>
  listHookSettingsFiles().filter(hasReplyHook);
