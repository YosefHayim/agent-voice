import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { ZodType } from "zod";

import { isErrorWithCode } from "#src/error-code.js";
import { readAgentVoiceHome } from "#src/settings/agent-voice-home.js";

const UTF8_ENCODING = "utf8";

// Dictated, refined, and reply text is readable by the user alone: its files are 0600 and its folders 0700.
const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_FOLDER_MODE = 0o700;

// chmod also tightens a folder an older build (or the user's umask) left readable by others.
export const makePrivateFolder = (folder: string): void => {
  mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
  chmodSync(folder, PRIVATE_FOLDER_MODE);
};

// Folders under agent-voice's home are tightened; a folder the user picked (say, for AGENT_VOICE_CONFIG_FILE) keeps its mode.
const makeParentFolder = (filePath: string): void => {
  const folder = path.dirname(filePath);
  const home = readAgentVoiceHome();
  const relative = path.relative(home, folder);

  const isOutsideHome = relative.startsWith("..") || path.isAbsolute(relative);
  if (isOutsideHome) {
    mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
    return;
  }

  makePrivateFolder(folder);
};

// A file created looser before is tightened before anything is written, so its earlier lines become private too.
export const openPrivateFile = (request: { readonly path: string; readonly flags: "a" | "w" }): number => {
  const folder = path.dirname(request.path);
  makePrivateFolder(folder);
  const descriptor = openSync(request.path, request.flags, PRIVATE_FILE_MODE);
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }

  return descriptor;
};

export const writePrivateFile = (request: {
  readonly path: string;
  readonly flags: "a" | "w";
  readonly contents: string | Uint8Array;
}): void => {
  const descriptor = openPrivateFile(request);
  try {
    writeFileSync(descriptor, request.contents);
  } finally {
    closeSync(descriptor);
  }
};

// Written through a temporary sibling and a rename, so readers never see half a file.
export const writeFileAtomically = (request: { readonly path: string; readonly contents: string }): void => {
  makeParentFolder(request.path);
  const folder = path.dirname(request.path);
  const fileName = path.basename(request.path);
  const staging = path.join(folder, `.${fileName}.${randomUUID()}.partial`);
  writeFileSync(staging, request.contents, { encoding: UTF8_ENCODING, mode: PRIVATE_FILE_MODE });
  renameSync(staging, request.path);
};

export const writeDocumentAtomically = (request: { readonly path: string; readonly value: unknown }): void => {
  const serializedField = JSON.stringify(request.value);
  writeFileAtomically({ path: request.path, contents: `${serializedField}\n` });
};

// Only a missing file is null; any other read failure is thrown, so a caller that writes the file back never
// mistakes an unreadable file for a missing one.
export const readFileIfExists = (filePath: string): string | null => {
  try {
    return readFileSync(filePath, UTF8_ENCODING);
  } catch (error) {
    const isMissing = isErrorWithCode(error, "ENOENT");
    if (isMissing) {
      return null;
    }

    throw error;
  }
};

// For files agent-voice only reads, never writes back: an unreadable file counts as missing.
export const readFileIfReadable = (filePath: string): string | null => {
  try {
    return readFileIfExists(filePath);
  } catch {
    // Read-only files: any failure to read means there is nothing to use, so the caller falls back to its default.
    return null;
  }
};

// A file that is not JSON, or does not match the schema, reads as null.
const parseDocumentFile = <Field>(fileMessages: string, schema: ZodType<Field>): Field | null => {
  try {
    const documentField: unknown = JSON.parse(fileMessages);
    const checkedReply = schema.safeParse(documentField);
    return checkedReply.success ? checkedReply.data : null;
  } catch {
    // Invalid JSON is an expected outcome for a state file, so it reads as missing.
    return null;
  }
};

export const readDocumentFile = <Value>(request: {
  readonly path: string;
  readonly schema: ZodType<Value>;
}): Value | null => {
  const fileMessages = readFileIfReadable(request.path);

  const isThereNoFileMessages = fileMessages == null;
  if (isThereNoFileMessages) {
    return null;
  }

  return parseDocumentFile(fileMessages, request.schema);
};

export const removeFileIfExists = (filePath: string): void => rmSync(filePath, { force: true });

export const touchFile = (filePath: string): void => {
  makeParentFolder(filePath);
  writeFileSync(filePath, "");
};
