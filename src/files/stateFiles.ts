/** Small state files: written through a temporary sibling and a rename, so readers never see half a file. */

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

import { Option, Schema } from "effect";

import { voxkeyHome } from "../settings/voxkeyHome.js";

// Dictated, refined, and reply text is readable by the user alone: its files are 0600 and its folders 0700.
const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_FOLDER_MODE = 0o700;

/** Create a private folder, or tighten one an older build (or the user's umask) left readable by others. */
export const makePrivateFolder = (folder: string): void => {
  mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
  chmodSync(folder, PRIVATE_FOLDER_MODE);
};

// Folders under voxkey's home are tightened; a folder the user picked (say, for VOXKEY_CONFIG_FILE) keeps its mode.
const makeFolderFor = (filePath: string): void => {
  const folder = path.dirname(filePath);
  const relative = path.relative(voxkeyHome(), folder);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
    return;
  }

  makePrivateFolder(folder);
};

/**
 * Open a file in a private folder to replace ("w") or append to ("a"). A new file is created 0600, and one created
 * looser before is tightened before anything is written, so its earlier lines become private too.
 */
export const openPrivateFile = (request: { readonly path: string; readonly flags: "a" | "w" }): number => {
  makePrivateFolder(path.dirname(request.path));
  const descriptor = openSync(request.path, request.flags, PRIVATE_FILE_MODE);
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return descriptor;
};

/** Replace or append to a private file (see openPrivateFile) with text or audio. */
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

export const writeFileAtomically = (request: { readonly path: string; readonly text: string }): void => {
  makeFolderFor(request.path);
  const staging = path.join(path.dirname(request.path), `.${path.basename(request.path)}.${randomUUID()}.partial`);
  writeFileSync(staging, request.text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  renameSync(staging, request.path);
};

export const writeJsonAtomically = (request: { readonly path: string; readonly value: unknown }): void =>
  writeFileAtomically({ path: request.path, text: `${JSON.stringify(request.value)}\n` });

const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

/**
 * The file's text, or none when it does not exist. Any other read failure is thrown: a caller that writes the
 * file back must never mistake an unreadable file for a missing one.
 */
export const readTextIfPresent = (filePath: string): Option.Option<string> => {
  try {
    return Option.some(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return Option.none();
    }

    throw error;
  }
};

/** The file's text, or none when it is missing or cannot be read: for files voxkey only reads, never writes back. */
export const readTextIfReadable = (filePath: string): Option.Option<string> => {
  try {
    return readTextIfPresent(filePath);
  } catch {
    return Option.none();
  }
};

/** The decoded JSON file, or none when it is missing, unreadable, not JSON, or the wrong shape. */
export const readJsonFile = <Value, Encoded>(request: {
  readonly path: string;
  readonly schema: Schema.Schema<Value, Encoded>;
}): Option.Option<Value> =>
  Option.flatMap(readTextIfReadable(request.path), Schema.decodeUnknownOption(Schema.parseJson(request.schema)));

export const removeIfPresent = (filePath: string): void => rmSync(filePath, { force: true });

export const touchFile = (filePath: string): void => {
  makeFolderFor(filePath);
  writeFileSync(filePath, "");
};
