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

import { agentVoiceHome } from "../settings/agentVoiceHome.js";

// Dictated, refined, and reply text is readable by the user alone: its files are 0600 and its folders 0700.
const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_FOLDER_MODE = 0o700;

// chmod also tightens a folder an older build (or the user's umask) left readable by others.
export const makePrivateFolder = (folder: string): void => {
  mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
  chmodSync(folder, PRIVATE_FOLDER_MODE);
};

// Folders under agent-voice's home are tightened; a folder the user picked (say, for AGENT_VOICE_CONFIG_FILE) keeps its mode.
const makeFolderFor = (filePath: string): void => {
  const folder = path.dirname(filePath);
  const home = agentVoiceHome();
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
export const writeFileAtomically = (request: { readonly path: string; readonly text: string }): void => {
  makeFolderFor(request.path);
  const folder = path.dirname(request.path);
  const fileName = path.basename(request.path);
  const staging = path.join(folder, `.${fileName}.${randomUUID()}.partial`);
  writeFileSync(staging, request.text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  renameSync(staging, request.path);
};

export const writeJsonAtomically = (request: { readonly path: string; readonly value: unknown }): void => {
  const json = JSON.stringify(request.value);
  writeFileAtomically({ path: request.path, text: `${json}\n` });
};

const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

// Only a missing file is none; any other read failure is thrown, so a caller that writes the file back never
// mistakes an unreadable file for a missing one.
export const readTextIfPresent = (filePath: string): Option.Option<string> => {
  try {
    const text = readFileSync(filePath, "utf8");
    return Option.some(text);
  } catch (error) {
    if (isMissingFile(error)) {
      return Option.none();
    }

    throw error;
  }
};

// For files agent-voice only reads, never writes back.
export const readTextIfReadable = (filePath: string): Option.Option<string> => {
  try {
    return readTextIfPresent(filePath);
  } catch {
    return Option.none();
  }
};

export const readJsonFile = <Value, Encoded>(request: {
  readonly path: string;
  readonly schema: Schema.Schema<Value, Encoded>;
}): Option.Option<Value> => {
  const decodeJson = Schema.decodeUnknownOption(Schema.parseJson(request.schema));
  return readTextIfReadable(request.path).pipe(Option.flatMap(decodeJson));
};

export const removeIfPresent = (filePath: string): void => rmSync(filePath, { force: true });

export const touchFile = (filePath: string): void => {
  makeFolderFor(filePath);
  writeFileSync(filePath, "");
};
