import { Command, Options } from "@effect/cli";
import { Option } from "effect";

import { runReplyHookFromArguments } from "../agents/replyHook.js";

// Free text, not a choice: an unknown agent must be a silent no-op, never a usage error (main.ts also routes
// `reply` around the parser, so this command mostly documents the hook in --help).
const agentOption = Options.text("agent").pipe(
  Options.withDescription("Which agent ran the hook: claude-code, codex, or grok"),
  Options.optional,
);

export const replyCommand = Command.make("reply", { agent: agentOption }, (args) => {
  const hookArguments = Option.match(args.agent, { onNone: () => [], onSome: (agent) => ["--agent", agent] });
  return runReplyHookFromArguments(hookArguments);
}).pipe(
  Command.withDescription(
    "Agent Stop hook: queue the agent's finished reply for speech. Prints nothing and always exits 0.",
  ),
);
