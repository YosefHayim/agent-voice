import { z } from "zod";

const GROK_AGENT_ID = "grok";

const CODEX_AGENT_ID = "codex";

const CLAUDE_CODE_AGENT_ID = "claude-code";

export const agentIdSchema = z.enum([CLAUDE_CODE_AGENT_ID, CODEX_AGENT_ID, GROK_AGENT_ID]);

export type AgentId = z.infer<typeof agentIdSchema>;

export interface AgentHookTarget {
  readonly agent: AgentId;
  readonly displayName: string;
  readonly homeFolder: string;
  readonly settingsFile: string;
  // True when the whole file belongs to agent-voice, so `agent-voice off` may delete it once it is empty.
  readonly ownFile: boolean;
}

// Grok reads every file in ~/.grok/hooks/, so agent-voice writes its own file there and never touches another tool's.
export const agentHookTargets: ReadonlyArray<AgentHookTarget> = [
  {
    agent: CLAUDE_CODE_AGENT_ID,
    displayName: "Claude Code",
    homeFolder: ".claude",
    settingsFile: "settings.json",
    ownFile: false,
  },
  { agent: CODEX_AGENT_ID, displayName: "Codex", homeFolder: ".codex", settingsFile: "hooks.json", ownFile: false },
  {
    agent: GROK_AGENT_ID,
    displayName: "Grok",
    homeFolder: ".grok",
    settingsFile: "hooks/agent-voice.json",
    ownFile: true,
  },
];
