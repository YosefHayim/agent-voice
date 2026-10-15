/** The agents whose end-of-turn (Stop) hook can run `voxkey reply`, and where each keeps its hook settings. */

import { Schema } from "effect";

export const agentIdSchema = Schema.Literal("claude-code", "codex", "grok");

export type AgentId = Schema.Schema.Type<typeof agentIdSchema>;

const agentHookTargetSchema = Schema.Struct({
  agent: agentIdSchema,
  displayName: Schema.NonEmptyTrimmedString,
  homeFolder: Schema.NonEmptyTrimmedString.annotations({
    description: "HOME-relative folder whose presence means the agent is installed.",
  }),
  settingsFile: Schema.NonEmptyTrimmedString.annotations({
    description: "HOME-relative JSON file holding the agent's hooks in the Claude-style hooks.Stop format.",
  }),
  ownFile: Schema.Boolean.annotations({
    description: "True when the whole file belongs to voxkey, so `voxkey off` may delete it once it is empty.",
  }),
});

export type AgentHookTarget = Schema.Schema.Type<typeof agentHookTargetSchema>;

// Grok reads every file in ~/.grok/hooks/, so voxkey writes its own file there and never touches another tool's.
export const agentHookTargets: ReadonlyArray<AgentHookTarget> = Schema.decodeUnknownSync(
  Schema.Array(agentHookTargetSchema),
)([
  {
    agent: "claude-code",
    displayName: "Claude Code",
    homeFolder: ".claude",
    settingsFile: ".claude/settings.json",
    ownFile: false,
  },
  { agent: "codex", displayName: "Codex", homeFolder: ".codex", settingsFile: ".codex/hooks.json", ownFile: false },
  { agent: "grok", displayName: "Grok", homeFolder: ".grok", settingsFile: ".grok/hooks/voxkey.json", ownFile: true },
]);
