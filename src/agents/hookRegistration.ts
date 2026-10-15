/** `voxkey on` / `voxkey off` for agent hooks: add or remove voxkey's Stop entry in each installed agent's settings. */

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Either, Option, Schema } from "effect";
import { makePrivateFolder, readJsonFile, readTextIfPresent, writeJsonAtomically } from "../files/stateFiles.js";
import { stateFile, stateFolder } from "../settings/voxkeyHome.js";
import { voxkeyInvocation } from "../workers/workerProcesses.js";
import { type AgentHookTarget, agentHookTargets, agentIdSchema } from "./agentCatalog.js";
import { addReplyHook, HookSettingsIssue, isEmptySettings, removeReplyHook, replyHookCommand } from "./hookSettings.js";

export const hookChangeSchema = Schema.Struct({
  agent: agentIdSchema,
  displayName: Schema.String,
  file: Schema.String,
  change: Schema.Literal("added", "unchanged", "removed", "absent", "not installed", "failed"),
  backup: Schema.optional(Schema.String),
  issue: Schema.optional(Schema.String),
});

export type HookChange = Schema.Schema.Type<typeof hookChangeSchema>;

const settingsPath = (target: AgentHookTarget) => path.join(homedir(), target.settingsFile);

const backupFile = (target: AgentHookTarget): string => {
  // Agent settings can hold tokens, so their copies are private like the rest of voxkey's state.
  const folder = stateFolder("backups");
  makePrivateFolder(folder);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backup = path.join(folder, `${target.agent}-${path.basename(target.settingsFile)}-${stamp}`);
  copyFileSync(settingsPath(target), backup);
  chmodSync(backup, 0o600);
  return backup;
};

// The agent's file keeps its permissions; the new text lands through a rename so the agent never reads half of it.
const writeSettings = (target: AgentHookTarget, text: string): void => {
  const file = settingsPath(target);
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
  mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.voxkey-partial`;
  writeFileSync(staging, text, { mode });
  renameSync(staging, file);
};

// Settings files voxkey created, so `voxkey off` can delete one it leaves empty and keep any file that existed before.
const createdFiles = (): ReadonlyArray<string> =>
  Option.getOrElse(
    readJsonFile({ path: stateFile("created-hook-files.json"), schema: Schema.Array(Schema.String) }),
    () => [],
  );

const recordCreated = (request: { readonly file: string; readonly created: boolean }): void => {
  const others = createdFiles().filter((file) => file !== request.file);
  writeJsonAtomically({
    path: stateFile("created-hook-files.json"),
    value: request.created ? [...others, request.file] : others,
  });
};

const isAgentInstalled = (target: AgentHookTarget) => existsSync(path.join(homedir(), target.homeFolder));

const changeFor = (target: AgentHookTarget, change: HookChange["change"]): HookChange => ({
  agent: target.agent,
  displayName: target.displayName,
  file: settingsPath(target),
  change,
});

// A settings file voxkey cannot read or parse is reported and left exactly as it is.
const reportFailure =
  (target: AgentHookTarget) =>
  (issue: HookSettingsIssue): HookChange => ({ ...changeFor(target, "failed"), issue: issue.message });

// Reading an unreadable file as missing would replace the user's settings with a hook-only file.
const readSettings = (target: AgentHookTarget): Either.Either<Option.Option<string>, HookSettingsIssue> =>
  Either.try({
    try: () => readTextIfPresent(settingsPath(target)),
    catch: (error) => new HookSettingsIssue({ issue: `the settings file could not be read (${String(error)})` }),
  });

const registerOne = (target: AgentHookTarget): HookChange => {
  if (!isAgentInstalled(target)) {
    return changeFor(target, "not installed");
  }

  const read = readSettings(target);
  if (Either.isLeft(read)) {
    return reportFailure(target)(read.left);
  }

  const current = read.right;
  const invocation = voxkeyInvocation();
  const command = replyHookCommand({
    nodePath: invocation.executable,
    scriptArguments: invocation.scriptArguments,
    agent: target.agent,
  });
  return Either.match(addReplyHook({ source: Option.getOrElse(current, () => ""), command, agent: target.agent }), {
    onLeft: reportFailure(target),
    onRight: (edit) => {
      if (!edit.changed) {
        return changeFor(target, "unchanged");
      }

      const backup = Option.isSome(current) ? backupFile(target) : undefined;
      writeSettings(target, edit.source);
      if (Option.isNone(current)) {
        recordCreated({ file: settingsPath(target), created: true });
      }
      return { ...changeFor(target, "added"), ...(backup === undefined ? {} : { backup }) };
    },
  });
};

const unregisterOne = (target: AgentHookTarget): HookChange => {
  const read = readSettings(target);
  if (Either.isLeft(read)) {
    return reportFailure(target)(read.left);
  }

  const current = read.right;
  if (Option.isNone(current)) {
    return changeFor(target, "absent");
  }

  return Either.match(removeReplyHook({ source: current.value, agent: target.agent }), {
    onLeft: reportFailure(target),
    onRight: (edit) => {
      if (!edit.changed) {
        return changeFor(target, "absent");
      }

      const backup = backupFile(target);
      const createdByVoxkey = target.ownFile || createdFiles().includes(settingsPath(target));
      if (createdByVoxkey && isEmptySettings(edit.source)) {
        rmSync(settingsPath(target), { force: true });
      } else {
        writeSettings(target, edit.source);
      }
      recordCreated({ file: settingsPath(target), created: false });
      return { ...changeFor(target, "removed"), backup };
    },
  });
};

/** Register `voxkey reply` as the Stop hook for every installed agent; a broken settings file is reported, not touched. */
export const registerReplyHooks: Effect.Effect<ReadonlyArray<HookChange>> = Effect.sync(() =>
  agentHookTargets.map(registerOne),
);

/** Remove voxkey's Stop entry from every agent settings file; everything else in the files stays. */
export const unregisterReplyHooks: Effect.Effect<ReadonlyArray<HookChange>> = Effect.sync(() =>
  agentHookTargets.map(unregisterOne),
);

const hasReplyHook = (target: AgentHookTarget): boolean =>
  Either.getOrElse(
    Either.flatMap(readSettings(target), (current) =>
      Option.match(current, {
        onNone: () => Either.right(false),
        onSome: (text) => Either.map(removeReplyHook({ source: text, agent: target.agent }), (edit) => edit.changed),
      }),
    ),
    () => false,
  );

/** Which agents currently run `voxkey reply`, for `voxkey status` and `voxkey doctor`. */
export const registeredAgents = (): ReadonlyArray<AgentHookTarget> => agentHookTargets.filter(hasReplyHook);
