import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Tests write only under the gitignored .test-home/, never to the real ~/.agent-voice or ~/.claude.
const testHomeRoot = path.join(repositoryRoot, ".test-home");

export const makeTestFolder = (name: string): string => {
  mkdirSync(testHomeRoot, { recursive: true });
  const folderPrefix = path.join(testHomeRoot, `${name}-`);
  return mkdtempSync(folderPrefix);
};

// macOS caps a socket path at 104 bytes, so a socket in a deep checkout or worktree is named relative to the test's working folder.
export const makeTestSocketPath = (folder: string): string => {
  const socketFile = path.join(folder, "c.sock");
  const workingFolder = process.cwd();
  return path.relative(workingFolder, socketFile);
};
