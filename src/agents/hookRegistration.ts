import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Either, Option, Schema } from "effect";
import { makePrivateFolder, readJsonFile, readTextIfPresent, writeJsonAtomically } from "../files/stateFiles.js";
import { stateFile, stateFolder } from "../settings/agentVoiceHome.js";
import { agentVoiceInvocation } from "../workers/workerProcesses.js";
import { type AgentHookTarget, agentHookTargets, agentIdSchema } from "./agentCatalog.js";
import { addReplyHook, HookSettingsIssue, isEmptySettings, removeReplyHook, replyHookCommand } from "./hookSettings.js";

const hookChangeSchema = Schema.Struct({
  agent: agentIdSchema,
  displayName: Schema.String,
  file: Schema.String,
  change: Schema.Literal("added", "unchanged", "removed", "absent", "not installed", "failed"),
  backup: Schema.optional(Schema.String),
  issue: Schema.optional(Schema.String),
});

export type HookChange = Schema.Schema.Type<typeof hookChangeSchema>;

const homePath = (relativePath: string): string => {
  const home = homedir();
  return path.join(home, relativePath);
};

const settingsPath = (target: AgentHookTarget): string => homePath(target.settingsFile);

const isAgentInstalled = (target: AgentHookTarget): boolean => {
  const agentFolder = homePath(target.homeFolder);
  return existsSync(agentFolder);
};

const backupFile = (target: AgentHookTarget): string => {
  // Agent settings can hold tokens, so their copies are private like the rest of agent-voice's state.
  const folder = stateFolder("backups");
  makePrivateFolder(folder);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backup = path.join(folder, `${target.agent}-${path.basename(target.settingsFile)}-${stamp}`);
  const file = settingsPath(target);
  copyFileSync(file, backup);
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
const writeSettings = (target: AgentHookTarget, text: string): void => {
  const file = settingsPath(target);
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

const changeFor = (target: AgentHookTarget, change: HookChange["change"]): HookChange => ({
  agent: target.agent,
  displayName: target.displayName,
  file: settingsPath(target),
  change,
});

// A settings file agent-voice cannot read or parse is reported and left exactly as it is.
const failedChange = (target: AgentHookTarget, issue: HookSettingsIssue): HookChange => ({
  ...changeFor(target, "failed"),
  issue: issue.message,
});

// Reading an unreadable file as missing would replace the user's settings with a hook-only file.
const readSettings = (target: AgentHookTarget): Either.Either<Option.Option<string>, HookSettingsIssue> => {
  const file = settingsPath(target);
  return Either.try({
    try: () => readTextIfPresent(file),
    catch: (error) => new HookSettingsIssue({ issue: `the settings file could not be read (${String(error)})` }),
  });
};

const agentVoiceReplyCommand = (target: AgentHookTarget): string => {
  const invocation = agentVoiceInvocation();
  return replyHookCommand({
    nodePath: invocation.executable,
    scriptArguments: invocation.scriptArguments,
    agent: target.agent,
  });
};

// A settings file agent-voice created is deleted once its entry was the only thing in it.
const saveRemoval = (target: AgentHookTarget, source: string): void => {
  const file = settingsPath(target);
  const isCreatedByAgentVoice = target.ownFile || createdFiles().includes(file);
  if (isCreatedByAgentVoice && isEmptySettings(source)) {
    rmSync(file, { force: true });
    return;
  }

  writeSettings(target, source);
};

const registerOne = (target: AgentHookTarget): HookChange => {
  if (!isAgentInstalled(target)) {
    return changeFor(target, "not installed");
  }

  const read = readSettings(target);
  if (Either.isLeft(read)) {
    return failedChange(target, read.left);
  }

  const current = read.right;
  const source = Option.getOrElse(current, () => "");
  const command = agentVoiceReplyCommand(target);
  const edit = addReplyHook({ source, command, agent: target.agent });
  if (Either.isLeft(edit)) {
    return failedChange(target, edit.left);
  }

  if (!edit.right.changed) {
    return changeFor(target, "unchanged");
  }

  const added = changeFor(target, "added");
  if (Option.isNone(current)) {
    writeSettings(target, edit.right.source);
    recordCreated({ file: added.file, created: true });
    return added;
  }

  const backup = backupFile(target);
  writeSettings(target, edit.right.source);
  return { ...added, backup };
};

const unregisterOne = (target: AgentHookTarget): HookChange => {
  const read = readSettings(target);
  if (Either.isLeft(read)) {
    return failedChange(target, read.left);
  }

  const current = read.right;
  if (Option.isNone(current)) {
    return changeFor(target, "absent");
  }

  const edit = removeReplyHook({ source: current.value, agent: target.agent });
  if (Either.isLeft(edit)) {
    return failedChange(target, edit.left);
  }

  if (!edit.right.changed) {
    return changeFor(target, "absent");
  }

  const backup = backupFile(target);
  const removed = changeFor(target, "removed");
  saveRemoval(target, edit.right.source);
  recordCreated({ file: removed.file, created: false });
  return { ...removed, backup };
};

export const registerReplyHooks: Effect.Effect<ReadonlyArray<HookChange>> = Effect.sync(() =>
  agentHookTargets.map(registerOne),
);

export const unregisterReplyHooks: Effect.Effect<ReadonlyArray<HookChange>> = Effect.sync(() =>
  agentHookTargets.map(unregisterOne),
);

const hasReplyHook = (target: AgentHookTarget): boolean => {
  const current = readSettings(target).pipe(Either.getOrElse(() => Option.none<string>()));
  if (Option.isNone(current)) {
    return false;
  }

  return removeReplyHook({ source: current.value, agent: target.agent }).pipe(
    Either.map((edit) => edit.changed),
    Either.getOrElse(() => false),
  );
};

export const registeredAgents = (): ReadonlyArray<AgentHookTarget> => agentHookTargets.filter(hasReplyHook);
