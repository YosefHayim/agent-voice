import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  version: string;
}

const findPackageJsonPath = (folder: string): string => {
  const candidatePath = path.join(folder, "package.json");

  const isTherePackageJson = existsSync(candidatePath);
  if (isTherePackageJson) return candidatePath;

  const parentFolder = path.dirname(folder);

  const isFilesystemRoot = parentFolder === folder;
  if (isFilesystemRoot) throw new Error("No package.json found above the CLI files.");

  return findPackageJsonPath(parentFolder);
};

// The folder depth differs between `src/cli` and the compiled `dist/src/cli`, so the file is found by walking up.
const cliFolder = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = findPackageJsonPath(cliFolder);
const packageJsonText = readFileSync(packageJsonPath, "utf8");
const packageJson: PackageJson = JSON.parse(packageJsonText);

export const agentVoiceVersion = packageJson.version;
