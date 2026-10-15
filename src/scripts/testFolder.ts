import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Tests write only under the gitignored .test-home/, never to the real ~/.voxkey or ~/.claude.
const testHomeRoot = path.join(repositoryRoot, ".test-home");

export const makeTestFolder = (name: string): string => {
  mkdirSync(testHomeRoot, { recursive: true });
  const folderPrefix = path.join(testHomeRoot, `${name}-`);
  return mkdtempSync(folderPrefix);
};
