import { existsSync } from "node:fs";

// `pnpm cli` loads .env here instead of with a Node flag, so the flag never reaches the worker and hook commands
// built from this process's Node flags.
const hasVariablesFile = existsSync(".env");
if (hasVariablesFile) {
  process.loadEnvFile(".env");
}

await import("../cli/main.js");
