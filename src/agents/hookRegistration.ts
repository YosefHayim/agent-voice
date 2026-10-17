import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Either, Option, Schema } from "effect";
import { makePrivateFolder, readJsonFile, readTextIfPresent, writeJsonAtomically } from "../files/stateFiles.js";
import { stateFile, stateFolder } from "../settings/agentVoiceHome.js";
import { agentVoiceInvocation } from "../workers/workerProcesses.js";
import { agentIdSchema } from "./agentCatalog.js";
import { addReplyHook, HookSettingsIssue, isEmptySettings, removeReplyHook, replyHookCommand } from "./hookSettings.js";
import { type HookSettingsFile, hookSettingsFiles, rememberClaudeConfigFolder } from "./hookSettingsFiles.js";

const hookChangeSchema = Schema.Struct({
  agent: agentIdSchema,
  displayName: Schema.String,
  file: Schema.String,
  change: Schema.Literal("added", "unchanged", "removed", "absent", "not installed", "failed"),
  backup: Schema.optional(Schema.String),
  issue: Schema.optional(Schema.String),
});

export type HookChange = Schema.Schema.Type<typeof hookChangeSchema>;

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
  if (!existsSync(file)) {
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
  return readJsonFile({ path: createdPath, schema: Schema.Array(Schema.String) }).pipe(Option.getOrElse(() => []));
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

const changeFor = (settings: HookSettingsFile, change: HookChange["change"]): HookChange => ({
  agent: settings.agent,
  displayName: settings.displayName,
  file: settings.file,
  change,
});

// A settings file agent-voice cannot read or parse is reported and left exactly as it is.
const failedChange = (settings: HookSettingsFile, issue: HookSettingsIssue): HookChange => ({
  ...changeFor(settings, "failed"),
  issue: issue.message,
});

// Reading an unreadable file as missing would replace the user's settings with a hook-only file.
const readSettings = (settings: HookSettingsFile): Either.Either<Option.Option<string>, HookSettingsIssue> =>
  Either.try({
    try: () => readTextIfPresent(settings.file),
    catch: (error) => new HookSettingsIssue({ issue: `the settings file could not be read (${String(error)})` }),
  });

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
  if (isCreatedByAgentVoice && isEmptySettings(source)) {
    rmSync(settings.file, { force: true });
    return;
  }

  writeSettings(settings, source);
};

const registerOne = (settings: HookSettingsFile): HookChange => {
  if (!isAgentInstalled(settings)) {
    return changeFor(settings, "not installed");
  }

  const read = readSettings(settings);
  if (Either.isLeft(read)) {
    return failedChange(settings, read.left);
  }

  const current = read.right;
  const source = Option.getOrElse(current, () => "");
  const command = agentVoiceReplyCommand(settings);
  const edit = addReplyHook({ source, command, agent: settings.agent });
  if (Either.isLeft(edit)) {
    return failedChange(settings, edit.left);
  }

  if (!edit.right.changed) {
    return changeFor(settings, "unchanged");
  }

  const added = changeFor(settings, "added");
  if (Option.isNone(current)) {
    writeSettings(settings, edit.right.source);
    recordCreated({ file: added.file, created: true });
    return added;
  }

  const backup = backupFile(settings);
  writeSettings(settings, edit.right.source);
  return { ...added, backup };
};

const unregisterOne = (settings: HookSettingsFile): HookChange => {
  const read = readSettings(settings);
  if (Either.isLeft(read)) {
    return failedChange(settings, read.left);
  }

  const current = read.right;
  if (Option.isNone(current)) {
    return changeFor(settings, "absent");
  }

  const edit = removeReplyHook({ source: current.value, agent: settings.agent });
  if (Either.isLeft(edit)) {
    return failedChange(settings, edit.left);
  }

  if (!edit.right.changed) {
    return changeFor(settings, "absent");
  }

  const backup = backupFile(settings);
  const removed = changeFor(settings, "removed");
  saveRemoval(settings, edit.right.source);
  recordCreated({ file: removed.file, created: false });
  return { ...removed, backup };
};

export const registerReplyHooks: Effect.Effect<ReadonlyArray<HookChange>> = Effect.sync(() => {
  rememberClaudeConfigFolder();
  return hookSettingsFiles().map(registerOne);
});

export const unregisterReplyHooks: Effect.Effect<ReadonlyArray<HookChange>> = Effect.sync(() =>
  hookSettingsFiles().map(unregisterOne),
);

const hasReplyHook = (settings: HookSettingsFile): boolean => {
  const current = readSettings(settings).pipe(Either.getOrElse(() => Option.none<string>()));
  if (Option.isNone(current)) {
    return false;
  }

  return removeReplyHook({ source: current.value, agent: settings.agent }).pipe(
    Either.map((edit) => edit.changed),
    Either.getOrElse(() => false),
  );
};

export const registeredSettingsFiles = (): ReadonlyArray<HookSettingsFile> => hookSettingsFiles().filter(hasReplyHook);
