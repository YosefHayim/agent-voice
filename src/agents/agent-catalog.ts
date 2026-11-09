import { z } from "zod";

export const agentIdSchema = z.enum(["claude-code", "codex", "grok"]);

export type AgentId = z.infer<typeof agentIdSchema>;

export interface AgentHookTarget {
  readonly agent: AgentId;
  readonly displayName: string;
  // HOME-relative folder whose presence means the agent is installed (Claude Code may have more).
  readonly homeFolder: string;
  // JSON file inside the agent's folder holding its hooks in the Claude-style hooks.Stop format.
  readonly settingsFile: string;
  // True when the whole file belongs to agent-voice, so `agent-voice off` may delete it once it is empty.
  readonly ownFile: boolean;
}

// Grok reads every file in ~/.grok/hooks/, so agent-voice writes its own file there and never touches another tool's.
export const agentHookTargets: ReadonlyArray<AgentHookTarget> = [
  {
    agent: "claude-code",
    displayName: "Claude Code",
    homeFolder: ".claude",
    settingsFile: "settings.json",
    ownFile: false,
  },
  { agent: "codex", displayName: "Codex", homeFolder: ".codex", settingsFile: "hooks.json", ownFile: false },
  {
    agent: "grok",
    displayName: "Grok",
    homeFolder: ".grok",
    settingsFile: "hooks/agent-voice.json",
    ownFile: true,
  },
];
