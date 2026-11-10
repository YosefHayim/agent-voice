import { existsSync } from "node:fs";

const DOTENV_FILE_NAME = ".env";

// `pnpm dev:cli` loads .env here instead of with a Node flag, so the flag never reaches the worker and hook commands
// built from this process's Node flags.
const hasVariablesFile = existsSync(DOTENV_FILE_NAME);
if (hasVariablesFile) {
  process.loadEnvFile(DOTENV_FILE_NAME);
}

await import("#src/cli/main.js");
