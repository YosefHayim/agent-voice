import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { readStatusFolder } from "#src/settings/agent-voice-home.js";
import type { Settings } from "#src/settings/config-schema.js";
import { sleep } from "#src/sleep.js";
import { writePrivateFile } from "#src/storage/state-files.js";
import {
  type CliRun,
  findCli,
  listNonBlankLines,
  parseDocumentOrNull,
  readCliFailureReason,
  runCli,
} from "./agent-cli.js";

const WORKSPACE_CREATE_STEP = "workspace create";

const WORKSPACE_REF_FIELD = "workspace_ref";

const WORKSPACE_ID_FIELD = "workspace_id";

const WORKSPACE_LIST_STEP = "workspace list";

const WORKSPACE_COMMAND = "workspace";

const MACHINE_READABLE_FLAG = "--json";

const IDENTIFY_COMMAND = "identify";

const SURFACE_SEND_KEY_METHOD = "surface.send_key";

const SURFACE_ID_FIELD = "surface_id";

const SURFACE_REF_FIELD = "surface_ref";

const CMUX_EXECUTABLE = "cmux";

const CMUX_TIMEOUT_MS = 15_000;

const pickKnownCmuxPath = (): string =>
  ["/Applications/cmux.app/Contents/Resources/bin/cmux", "/usr/local/bin/cmux", "/opt/homebrew/bin/cmux"].find(
    (candidate) => existsSync(candidate),
  ) || CMUX_EXECUTABLE;

const pickCmuxExecutable = (): string => findCli(CMUX_EXECUTABLE) ?? pickKnownCmuxPath();

// Every failure is an Error that names the cmux step, so the log says which call failed.
const createCmuxError = (step: string, detail: string): Error => new Error(`cmux ${step}: ${detail}`);

const cmuxObjectSchema = z.record(z.string(), z.unknown());

const readPlainObject = (field: unknown): Readonly<Record<string, unknown>> | null => {
  const checked = cmuxObjectSchema.safeParse(field);

  const isCheckFailed = !checked.success;
  if (isCheckFailed) {
    return null;
  }

  return checked.data;
};

const readNonEmptyField = (field: unknown): string | null => {
  const isFieldBlank = typeof field !== "string" || field === "";
  if (isFieldBlank) {
    return null;
  }

  return field;
};

const readFirstFilledField = (field: unknown, keys: ReadonlyArray<string>): string | null => {
  const stored = readPlainObject(field);

  const isNotPlainObject = stored == null;
  if (isNotPlainObject) {
    return null;
  }

  for (const key of keys) {
    const found = readNonEmptyField(stored[key]);

    const isFound = found != null;
    if (isFound) {
      return found;
    }
  }

  return null;
};

// cmux may print notices before its JSON line.
const readCmuxReply = (stdout: string): unknown => {
  const documentLines = listNonBlankLines(stdout).filter((line) => line.startsWith("{"));
  const lastDocumentLine = documentLines.at(-1) ?? "";
  const wholeReply = parseDocumentOrNull(stdout.trim());

  const isWholeReplyDocument = wholeReply !== null;
  if (isWholeReplyDocument) {
    return wholeReply;
  }

  return parseDocumentOrNull(lastDocumentLine);
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

const runCmuxDocument = async (request: {
  readonly args: ReadonlyArray<string>;
  readonly step: string;
}): Promise<unknown> => {
  const executable = pickCmuxExecutable();
  const cliRun = await runCmuxCli({ executable, args: request.args, step: request.step });

  const isFailedExit = cliRun.exitCode !== 0;
  if (isFailedExit) {
    const detail = readCliFailureReason(cliRun) || "failed";
    throw createCmuxError(request.step, detail);
  }

  return readCmuxReply(cliRun.stdout);
};

// cmux addresses a surface by `surface_ref` (`surface:N`) or by `surface_id` (UUID).
const readSurfaceKey = (surface: string): string => {
  const isSurfaceRef = surface.startsWith("surface:");
  if (isSurfaceRef) {
    return SURFACE_REF_FIELD;
  }

  return SURFACE_ID_FIELD;
};

export const readSurfaceParameters = (
  surface: string,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const key = readSurfaceKey(surface);
  return { [key]: surface, ...fields };
};

const callRpc = (method: string, parameters: Readonly<Record<string, string>>): Promise<unknown> => {
  const parametersDocument = JSON.stringify(parameters);
  return runCmuxDocument({ args: ["rpc", method, parametersDocument], step: `rpc ${method}` });
};

// Some cmux builds name the key "return" instead of "enter". A key that fails to send is logged, not thrown.
const pressEnterKey = async (surface: string): Promise<void> => {
  const enterParameters = readSurfaceParameters(surface, { key: "enter" });
  const returnParameters = readSurfaceParameters(surface, { key: "return" });
  try {
    await callRpc(SURFACE_SEND_KEY_METHOD, enterParameters);
  } catch (enterError) {
    console.error({ surface, enterError });
    try {
      await callRpc(SURFACE_SEND_KEY_METHOD, returnParameters);
    } catch (returnError) {
      console.error({ surface, returnError });
    }
  }
};

const sendMessageToSurface = async (request: {
  readonly surface: string;
  readonly text: string;
  readonly pressEnter: boolean;
}): Promise<void> => {
  const stringParameters = readSurfaceParameters(request.surface, { text: request.text });
  await callRpc("surface.send_text", stringParameters);

  if (request.pressEnter) {
    await pressEnterKey(request.surface);
  }
};

const readFocusedOrCaller = (identity: unknown): unknown => {
  const stored = readPlainObject(identity);

  const isNotPlainObject = stored == null;
  if (isNotPlainObject) {
    return identity;
  }

  return stored.focused ?? stored.caller ?? identity;
};

const identifyFocus = async (): Promise<unknown> => {
  const identity = await runCmuxDocument({
    args: [IDENTIFY_COMMAND, MACHINE_READABLE_FLAG, "--id-format", "both"],
    step: IDENTIFY_COMMAND,
  });
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
    const listing = await runCmuxDocument({
      args: [WORKSPACE_COMMAND, "list", MACHINE_READABLE_FLAG],
      step: WORKSPACE_LIST_STEP,
    });
    return readWorkspaces(listing);
  } catch (error) {
    console.error({ step: WORKSPACE_LIST_STEP, error });
    return [];
  }
};

const readFocusedWorkspaceId = async (): Promise<string> => {
  try {
    const focus = await identifyFocus();
    return readFirstFilledField(focus, [WORKSPACE_ID_FIELD, WORKSPACE_REF_FIELD]) ?? "";
  } catch (error) {
    console.error({ step: IDENTIFY_COMMAND, error });
    return "";
  }
};

const readWorkspaceDirectory = (workspace: unknown): string | null =>
  readFirstFilledField(workspace, ["current_directory"]);

const isFocusedWorkspace = (workspace: unknown, focusId: string): boolean => {
  const id = readFirstFilledField(workspace, ["id", WORKSPACE_ID_FIELD, "ref"]) ?? "";

  const isUnknownWorkspace = id === "" || focusId === "";
  if (isUnknownWorkspace) {
    return false;
  }

  return id === focusId || id.endsWith(focusId) || focusId.endsWith(id);
};

const readFirstWorkspaceDirectory = (workspaces: ReadonlyArray<unknown>): string | null => {
  for (const workspace of workspaces) {
    const directory = readWorkspaceDirectory(workspace);

    const isFound = directory != null;
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
  const isFocusedMissing = focused == null;
  const focusedDirectory = isFocusedMissing ? null : readWorkspaceDirectory(focused);

  const isFocusedFolderFound = focusedDirectory != null;
  if (isFocusedFolderFound) {
    return focusedDirectory;
  }

  const firstDirectory = readFirstWorkspaceDirectory(workspaces);

  const isFirstFolderFound = firstDirectory != null;
  if (isFirstFolderFound) {
    return firstDirectory;
  }

  return homedir();
};

// Safe inside a single-quoted shell string: ' becomes '\''.
export const quoteShellWord = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

// One pass, so a folder with spaces or `$(...)` stays one literal word, and text inserted by one placeholder is never expanded again.
export const expandCommandTemplate = (request: {
  readonly template: string;
  readonly prompt: string;
  readonly promptFile: string;
  readonly folder: string;
}): string => {
  const fields: Readonly<Record<string, string>> = {
    prompt_file: request.promptFile,
    prompt: request.prompt,
    cwd: request.folder,
  };
  return request.template.replace(/\{\{(prompt_file|prompt|cwd)\}\}/gu, (_placeholder, name: string) =>
    quoteShellWord(fields[name] || ""),
  );
};

export const readWorkspaceTitle = (word: string): string => {
  const firstLine = word.split("\n")[0] || "";
  const characters = [...firstLine.trim()];
  const shortLineCharacterCount = 40;

  const shortLine = characters.slice(0, shortLineCharacterCount).join("");

  const isLineEmpty = shortLine === "";
  if (isLineEmpty) {
    return "refine";
  }

  return `refine: ${shortLine}`;
};

const writePromptFile = (prompt: string): string => {
  const promptsFolder = readStatusFolder("prompts");
  const promptFile = path.join(promptsFolder, `prompt-${randomUUID()}.txt`);
  writePrivateFile({ path: promptFile, flags: "w", contents: `${prompt}\n` });
  return promptFile;
};

const createWorkspaceArgumentList = (request: {
  readonly promptText: string;
  readonly folder: string;
}): ReadonlyArray<string> => {
  const title = readWorkspaceTitle(request.promptText);
  return [WORKSPACE_COMMAND, "create", "--name", title, "--cwd", request.folder, "--focus", "true"];
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
  const createArgumentList = createWorkspaceArgumentList({ promptText: request.promptText, folder: request.folder });
  const created = await runCmuxDocument({
    args: [...createArgumentList, "--command", command, MACHINE_READABLE_FLAG],
    step: WORKSPACE_CREATE_STEP,
  });
  const workspace = readFirstFilledField(created, [WORKSPACE_REF_FIELD, WORKSPACE_ID_FIELD]) ?? "?";
  return `cmux-new ran a command in workspace ${workspace}`;
};

// Gives the new terminal a moment to accept input.
const surfaceReadyDelayMilliseconds = 350;

const pasteInNewWorkspace = async (request: {
  readonly promptText: string;
  readonly folder: string;
  readonly pressEnter: boolean;
}): Promise<string> => {
  const createArgumentList = createWorkspaceArgumentList({ promptText: request.promptText, folder: request.folder });
  const created = await runCmuxDocument({
    args: [...createArgumentList, MACHINE_READABLE_FLAG],
    step: WORKSPACE_CREATE_STEP,
  });
  const surface = readFirstFilledField(created, [SURFACE_ID_FIELD, SURFACE_REF_FIELD]);

  const hasNoSurface = surface == null;
  if (hasNoSurface) {
    throw createCmuxError(WORKSPACE_CREATE_STEP, "no surface id in the reply");
  }

  await sleep(surfaceReadyDelayMilliseconds);
  await sendMessageToSurface({ surface, text: request.promptText, pressEnter: request.pressEnter });
  return `cmux-new pasted into surface ${surface}`;
};

const deliverToNewWorkspace = async (request: {
  readonly promptText: string;
  readonly config: Settings;
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
  readonly config: Settings;
}): Promise<string> => {
  const focus = await identifyFocus();
  const surface = readFirstFilledField(focus, [SURFACE_ID_FIELD, SURFACE_REF_FIELD]);

  const hasNoSurface = surface == null;
  if (hasNoSurface) {
    throw createCmuxError(IDENTIFY_COMMAND, "no focused surface");
  }

  await sendMessageToSurface({
    surface,
    text: request.promptText,
    pressEnter: request.config.refineCmuxPressEnter,
  });
  return `cmux-resume sent to surface ${surface}`;
};

// Returns a one-line summary for the dictation log. Throws an Error that names the cmux step when delivery fails.
export const deliverToCmux = async (request: {
  readonly promptText: string;
  readonly config: Settings;
}): Promise<string> => {
  const prompt = request.promptText.trim();
  switch (request.config.refineSendTo) {
    case "cmux-new":
      return deliverToNewWorkspace({ promptText: prompt, config: request.config });
    case "cmux-resume":
      return deliverToFocusedSurface({ promptText: prompt, config: request.config });
    case "caret":
      throw createCmuxError("deliver", "caret delivery types at the caret");
  }
};
