import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { readStateFolder } from "#src/settings/agent-voice-home.js";
import type { Config } from "#src/settings/config-schema.js";
import { sleep } from "#src/sleep.js";
import { writePrivateFile } from "#src/storage/state-files.js";
import { type CliRun, findCli, listNonBlankLines, parseJsonOrNull, readCliFailureText, runCli } from "./agent-cli.js";

const CMUX_TIMEOUT_MS = 15_000;

const KNOWN_CMUX_PATHS = [
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
  "/usr/local/bin/cmux",
  "/opt/homebrew/bin/cmux",
];

const pickKnownCmuxPath = (): string => KNOWN_CMUX_PATHS.find((candidate) => existsSync(candidate)) || "cmux";

const pickCmuxExecutable = (): string => findCli("cmux") ?? pickKnownCmuxPath();

// Every failure is an Error that names the cmux step, so the log says which call failed.
const createCmuxError = (step: string, detail: string): Error => new Error(`cmux ${step}: ${detail}`);

const cmuxRecordSchema = z.record(z.string(), z.unknown());

const readRecord = (value: unknown): Readonly<Record<string, unknown>> | null => {
  const checked = cmuxRecordSchema.safeParse(value);

  const isCheckFailed = !checked.success;
  if (isCheckFailed) {
    return null;
  }

  return checked.data;
};

const readNonEmptyString = (value: unknown): string | null => {
  const isNotNonEmptyText = typeof value !== "string" || value === "";
  if (isNotNonEmptyText) {
    return null;
  }

  return value;
};

// The first key whose value is a non-empty string.
const readFirstString = (value: unknown, keys: ReadonlyArray<string>): string | null => {
  const record = readRecord(value);

  const isNotRecord = record === null;
  if (isNotRecord) {
    return null;
  }

  for (const key of keys) {
    const found = readNonEmptyString(record[key]);

    const isFound = found !== null;
    if (isFound) {
      return found;
    }
  }

  return null;
};

// cmux may print notices before its JSON line.
const readCmuxReply = (stdout: string): unknown => {
  const jsonLines = listNonBlankLines(stdout).filter((line) => line.startsWith("{"));
  const lastJsonLine = jsonLines.at(-1) ?? "";
  const wholeReply = parseJsonOrNull(stdout.trim());

  const isWholeReplyJson = wholeReply !== null;
  if (isWholeReplyJson) {
    return wholeReply;
  }

  return parseJsonOrNull(lastJsonLine);
};

const runCmuxCli = async (request: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly step: string;
}): Promise<CliRun> => {
  try {
    return await runCli({
      executable: request.executable,
      args: request.args,
      timeoutMs: CMUX_TIMEOUT_MS,
      environment: { CMUX_QUIET: "1" },
      signal: AbortSignal.timeout(CMUX_TIMEOUT_MS),
    });
  } catch (error) {
    const isErrorInstanceError = error instanceof Error;
    const detail = isErrorInstanceError ? error.message : String(error);
    throw new Error(`cmux ${request.step}: ${detail}`, { cause: error });
  }
};

const runCmuxJson = async (request: {
  readonly args: ReadonlyArray<string>;
  readonly step: string;
}): Promise<unknown> => {
  const executable = pickCmuxExecutable();
  const cliRun = await runCmuxCli({ executable, args: request.args, step: request.step });

  const isFailedExit = cliRun.exitCode !== 0;
  if (isFailedExit) {
    const detail = readCliFailureText(cliRun) || "failed";
    throw createCmuxError(request.step, detail);
  }

  return readCmuxReply(cliRun.stdout);
};

// cmux addresses a surface by `surface_ref` (`surface:N`) or by `surface_id` (UUID).
const readSurfaceKey = (surface: string): string => {
  const isSurfaceRef = surface.startsWith("surface:");
  if (isSurfaceRef) {
    return "surface_ref";
  }

  return "surface_id";
};

export const readSurfaceParams = (
  surface: string,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const key = readSurfaceKey(surface);
  return { [key]: surface, ...fields };
};

const callRpc = (method: string, params: Readonly<Record<string, string>>): Promise<unknown> => {
  const paramsJson = JSON.stringify(params);
  return runCmuxJson({ args: ["rpc", method, paramsJson], step: `rpc ${method}` });
};

// Some cmux builds name the key "return" instead of "enter". A key that fails to send is logged, not thrown.
const pressEnterKey = async (surface: string): Promise<void> => {
  const enterParams = readSurfaceParams(surface, { key: "enter" });
  const returnParams = readSurfaceParams(surface, { key: "return" });
  try {
    await callRpc("surface.send_key", enterParams);
  } catch (enterError) {
    console.error({ surface, enterError });
    try {
      await callRpc("surface.send_key", returnParams);
    } catch (returnError) {
      console.error({ surface, returnError });
    }
  }
};

const sendTextToSurface = async (request: {
  readonly surface: string;
  readonly text: string;
  readonly pressEnter: boolean;
}): Promise<void> => {
  const textParams = readSurfaceParams(request.surface, { text: request.text });
  await callRpc("surface.send_text", textParams);

  if (request.pressEnter) {
    await pressEnterKey(request.surface);
  }
};

const readFocusedOrCaller = (identity: unknown): unknown => {
  const record = readRecord(identity);

  const isNotRecord = record === null;
  if (isNotRecord) {
    return identity;
  }

  return record.focused ?? record.caller ?? identity;
};

const identifyFocus = async (): Promise<unknown> => {
  const identity = await runCmuxJson({ args: ["identify", "--json", "--id-format", "both"], step: "identify" });
  return readFocusedOrCaller(identity);
};

const workspaceListSchema = z.object({
  workspaces: z.array(z.record(z.string(), z.unknown())),
});

const readWorkspaces = (listing: unknown): ReadonlyArray<unknown> => {
  const checked = workspaceListSchema.safeParse(listing);

  const isCheckFailed = !checked.success;
  if (isCheckFailed) {
    return [];
  }

  return checked.data.workspaces;
};

const listWorkspaces = async (): Promise<ReadonlyArray<unknown>> => {
  try {
    const listing = await runCmuxJson({ args: ["workspace", "list", "--json"], step: "workspace list" });
    return readWorkspaces(listing);
  } catch (error) {
    console.error({ step: "workspace list", error });
    return [];
  }
};

const readFocusedWorkspaceId = async (): Promise<string> => {
  try {
    const focus = await identifyFocus();
    return readFirstString(focus, ["workspace_id", "workspace_ref"]) ?? "";
  } catch (error) {
    console.error({ step: "identify", error });
    return "";
  }
};

const readWorkspaceDirectory = (workspace: unknown): string | null => readFirstString(workspace, ["current_directory"]);

const isFocusedWorkspace = (workspace: unknown, focusId: string): boolean => {
  const id = readFirstString(workspace, ["id", "workspace_id", "ref"]) ?? "";

  const isUnknownWorkspace = id === "" || focusId === "";
  if (isUnknownWorkspace) {
    return false;
  }

  return id === focusId || id.endsWith(focusId) || focusId.endsWith(id);
};

const readFirstWorkspaceDirectory = (workspaces: ReadonlyArray<unknown>): string | null => {
  for (const workspace of workspaces) {
    const directory = readWorkspaceDirectory(workspace);

    const isFound = directory !== null;
    if (isFound) {
      return directory;
    }
  }

  return null;
};

// The focused workspace's folder, else the first workspace's folder, else the home folder.
const readDeliveryFolder = async (): Promise<string> => {
  const workspaces = await listWorkspaces();
  const focusId = await readFocusedWorkspaceId();
  const focused = workspaces.find((workspace) => isFocusedWorkspace(workspace, focusId));
  const isFocusedMissing = focused === undefined;
  const focusedDirectory = isFocusedMissing ? null : readWorkspaceDirectory(focused);

  const isFocusedFolderFound = focusedDirectory !== null;
  if (isFocusedFolderFound) {
    return focusedDirectory;
  }

  const firstDirectory = readFirstWorkspaceDirectory(workspaces);

  const isFirstFolderFound = firstDirectory !== null;
  if (isFirstFolderFound) {
    return firstDirectory;
  }

  return homedir();
};

// Safe inside a single-quoted shell string: ' becomes '\''.
export const quoteShellWord = (plainText: string): string => `'${plainText.replaceAll("'", "'\\''")}'`;

// One pass, so a folder with spaces or `$(...)` stays one literal word, and text inserted by one placeholder is never expanded again.
export const expandCommandTemplate = (request: {
  readonly template: string;
  readonly prompt: string;
  readonly promptFile: string;
  readonly folder: string;
}): string => {
  const values: Readonly<Record<string, string>> = {
    prompt_file: request.promptFile,
    prompt: request.prompt,
    cwd: request.folder,
  };
  return request.template.replace(/\{\{(prompt_file|prompt|cwd)\}\}/gu, (_placeholder, name: string) =>
    quoteShellWord(values[name] || ""),
  );
};

export const readWorkspaceTitle = (plainText: string): string => {
  const firstLine = plainText.split("\n")[0] || "";
  const characters = [...firstLine.trim()];
  const shortLine = characters.slice(0, 40).join("");

  const isLineEmpty = shortLine === "";
  if (isLineEmpty) {
    return "refine";
  }

  return `refine: ${shortLine}`;
};

const writePromptFile = (promptText: string): string => {
  const promptsFolder = readStateFolder("prompts");
  const promptFile = path.join(promptsFolder, `prompt-${randomUUID()}.txt`);
  writePrivateFile({ path: promptFile, flags: "w", contents: `${promptText}\n` });
  return promptFile;
};

const createWorkspaceArgs = (request: {
  readonly promptText: string;
  readonly folder: string;
}): ReadonlyArray<string> => {
  const title = readWorkspaceTitle(request.promptText);
  return ["workspace", "create", "--name", title, "--cwd", request.folder, "--focus", "true"];
};

const runInNewWorkspace = async (request: {
  readonly promptText: string;
  readonly template: string;
  readonly folder: string;
}): Promise<string> => {
  const promptFile = writePromptFile(request.promptText);
  const command = expandCommandTemplate({
    template: request.template,
    prompt: request.promptText,
    promptFile,
    folder: request.folder,
  });
  const createArgs = createWorkspaceArgs({ promptText: request.promptText, folder: request.folder });
  const created = await runCmuxJson({
    args: [...createArgs, "--command", command, "--json"],
    step: "workspace create",
  });
  const workspace = readFirstString(created, ["workspace_ref", "workspace_id"]) ?? "?";
  return `cmux-new ran a command in workspace ${workspace}`;
};

// Gives the new terminal a moment to accept input.
const surfaceReadyDelayMilliseconds = 350;

const pasteInNewWorkspace = async (request: {
  readonly promptText: string;
  readonly folder: string;
  readonly pressEnter: boolean;
}): Promise<string> => {
  const createArgs = createWorkspaceArgs({ promptText: request.promptText, folder: request.folder });
  const created = await runCmuxJson({ args: [...createArgs, "--json"], step: "workspace create" });
  const surface = readFirstString(created, ["surface_id", "surface_ref"]);

  const hasNoSurface = surface === null;
  if (hasNoSurface) {
    throw createCmuxError("workspace create", "no surface id in the reply");
  }

  await sleep(surfaceReadyDelayMilliseconds);
  await sendTextToSurface({ surface, text: request.promptText, pressEnter: request.pressEnter });
  return `cmux-new pasted into surface ${surface}`;
};

const deliverToNewWorkspace = async (request: {
  readonly promptText: string;
  readonly config: Config;
}): Promise<string> => {
  const folder = await readDeliveryFolder();
  const template = request.config.refineCmuxCommand;

  const isCommandTemplate = template !== "";
  if (isCommandTemplate) {
    return runInNewWorkspace({ promptText: request.promptText, template, folder });
  }

  return pasteInNewWorkspace({
    promptText: request.promptText,
    folder,
    pressEnter: request.config.refineCmuxPressEnter,
  });
};

const deliverToFocusedSurface = async (request: {
  readonly promptText: string;
  readonly config: Config;
}): Promise<string> => {
  const focus = await identifyFocus();
  const surface = readFirstString(focus, ["surface_id", "surface_ref"]);

  const hasNoSurface = surface === null;
  if (hasNoSurface) {
    throw createCmuxError("identify", "no focused surface");
  }

  await sendTextToSurface({
    surface,
    text: request.promptText,
    pressEnter: request.config.refineCmuxPressEnter,
  });
  return `cmux-resume sent to surface ${surface}`;
};

// Returns a one-line summary for the dictation log. Throws an Error that names the cmux step when delivery fails.
export const deliverToCmux = async (request: {
  readonly promptText: string;
  readonly config: Config;
}): Promise<string> => {
  const promptText = request.promptText.trim();
  switch (request.config.refineSendTo) {
    case "cmux-new":
      return deliverToNewWorkspace({ promptText, config: request.config });
    case "cmux-resume":
      return deliverToFocusedSurface({ promptText, config: request.config });
    case "caret":
      throw createCmuxError("deliver", "caret delivery types at the caret");
  }
};
