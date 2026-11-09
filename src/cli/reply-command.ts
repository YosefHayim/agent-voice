import type { CommandSpec } from "./command-spec.js";

// main.ts routes `reply` straight to the hook before any parsing; this entry only documents it in --help.
export const replyCommand: CommandSpec = {
  name: "reply",
  description: "Agent Stop hook: queue the agent's finished reply for speech. Prints nothing and always exits 0.",
  flags: {
    agent: { kind: "text", description: "Which agent ran the hook: claude-code, codex, or grok" },
  },
  positionals: [],
};
