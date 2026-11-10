import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageDocument {
  version: string;
}

const findPackageDocumentPath = (folder: string): string => {
  const candidatePath = path.join(folder, "package.json");

  const isTherePackageDocument = existsSync(candidatePath);
  if (isTherePackageDocument) return candidatePath;

  const parentFolder = path.dirname(folder);

  const isFilesystemRoot = parentFolder === folder;
  if (isFilesystemRoot) throw new Error("No package.json found above the CLI files.");

  return findPackageDocumentPath(parentFolder);
};

// The folder depth differs between `src/cli` and the compiled `dist/src/cli`, so the file is found by walking up.
const cliFilePath = fileURLToPath(import.meta.url);
const cliFolder = path.dirname(cliFilePath);
const packageDocumentPath = findPackageDocumentPath(cliFolder);
const packageDocumentFile = readFileSync(packageDocumentPath, "utf8");
const packageDocument: PackageDocument = JSON.parse(packageDocumentFile);

export const agentVoiceVersion = packageDocument.version;
