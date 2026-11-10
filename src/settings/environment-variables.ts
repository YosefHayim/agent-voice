export interface AgentVoiceEnvironment {
  readonly AGENT_VOICE_HOME: string;
  readonly AGENT_VOICE_CONFIG_FILE: string;
  readonly AGENT_VOICE_DICTATION_MODEL: string;
  readonly AGENT_VOICE_DICTATION_LIVE_PREVIEW: boolean;
  readonly AGENT_VOICE_REFINE_PICKER: boolean;
  readonly CI: string;
}

interface AgentVoiceVariable {
  readonly name: string;
  readonly description: string;
}

// "off", "0", "false", and "no" switch a feature off; anything else (or unset) leaves it on.
const isSwitchOn = (string: string | undefined): boolean => {
  const isUnset = string == null;
  if (isUnset) {
    return true;
  }

  const offWords = ["0", "false", "off", "no"];
  const word = string.trim().toLowerCase();
  return !offWords.includes(word);
};

const trimWord = (string: string | undefined): string => (string ?? "").trim();

export const readEnvironment = (): AgentVoiceEnvironment => ({
  AGENT_VOICE_HOME: trimWord(process.env.AGENT_VOICE_HOME),
  AGENT_VOICE_CONFIG_FILE: trimWord(process.env.AGENT_VOICE_CONFIG_FILE),
  AGENT_VOICE_DICTATION_MODEL: trimWord(process.env.AGENT_VOICE_DICTATION_MODEL),
  AGENT_VOICE_DICTATION_LIVE_PREVIEW: isSwitchOn(process.env.AGENT_VOICE_DICTATION_LIVE_PREVIEW),
  AGENT_VOICE_REFINE_PICKER: isSwitchOn(process.env.AGENT_VOICE_REFINE_PICKER),
  CI: trimWord(process.env.CI),
});

// README and .env.example list exactly these: agent-voice's own variables, not CI.
export const agentVoiceVariables: ReadonlyArray<AgentVoiceVariable> = [
  {
    name: "AGENT_VOICE_HOME",
    description: "Folder for agent-voice's config, state, models, and logs. Default: ~/.agent-voice.",
  },
  {
    name: "AGENT_VOICE_CONFIG_FILE",
    description:
      "Path to the config file. When set, it is the only config file read. Default: $AGENT_VOICE_HOME/config.json.",
  },
  {
    name: "AGENT_VOICE_DICTATION_MODEL",
    description:
      "Forces the Whisper model: turbo-q5, turbo-q8, turbo, small, base, tiny, or ivrit. Overrides the dictation-model setting. Default: unset.",
  },
  {
    name: "AGENT_VOICE_DICTATION_LIVE_PREVIEW",
    description: "Set to off (or 0, false, no) to stop the live caption while the hold key is held. Default: on.",
  },
  {
    name: "AGENT_VOICE_REFINE_PICKER",
    description:
      "Set to off (or 0, false, no) so a failed refine never opens the macOS model picker (CI, headless Macs). Default: on.",
  },
];
