import { deliverToCmux } from "#src/refine/cmux-delivery.js";
import { discoverProviders, REASONING_EFFORTS } from "#src/refine/provider-models.js";
import { refinePrompt } from "#src/refine/refine-attempts.js";
import { readConfig } from "#src/settings/config-file.js";
import { refineProviders } from "#src/settings/config-schema.js";
import { type CommandSpec, isFlagOn, readOptionalPositional, readStringFlag } from "./command-spec.js";
import { speakAloud } from "./speak-command.js";
import * as TerminalUI from "./terminal-ui.js";

const refineSendTargets = ["caret", "cmux-new", "cmux-resume"] as const;

export const refineCommand: CommandSpec = {
  name: "refine",
  description: "Refine one prompt with an agent CLI (codex, claude, grok, …) and print the result",
  flags: {
    speak: { kind: "boolean", description: "Read the refined prompt aloud" },
    provider: {
      kind: "text",
      description: "Provider for this run (default: refine-provider)",
      choices: refineProviders,
    },
    model: { kind: "text", description: "Model for this run (default: refine-model)" },
    effort: {
      kind: "text",
      description: "Reasoning effort for this run (default: refine-effort)",
      choices: REASONING_EFFORTS,
    },
    "send-to": {
      kind: "text",
      description: "Also send the result to cmux (caret only prints it)",
      choices: refineSendTargets,
    },
    "cmux-command": {
      kind: "text",
      description: "Command template for cmux-new ({{prompt_file}}, {{prompt}}, {{cwd}}, each shell-quoted)",
    },
    "press-enter": { kind: "boolean", description: "Press Enter after sending to cmux" },
    "list-providers": {
      kind: "boolean",
      description: "Print the agent CLIs found on this Mac and their models as JSON, then exit",
    },
  },
  positionals: [{ name: "prompt", description: "The draft prompt to refine", isRequired: false }],
  run: async (parsedCommand) => {
    const isListProvidersWanted = isFlagOn(parsedCommand, "list-providers");
    if (isListProvidersWanted) {
      const providers = await discoverProviders({ refresh: true });
      TerminalUI.printDocument({ providers });
      return 0;
    }

    const draft = readOptionalPositional(parsedCommand, "prompt") ?? "";
    const isDraftMissing = draft.trim() === "";
    if (isDraftMissing) {
      TerminalUI.printError("Pass the prompt to refine, or --list-providers.");
      return 2;
    }

    const savedSettings = readConfig();
    const providerWord = readStringFlag(parsedCommand, "provider");
    const sendToWord = readStringFlag(parsedCommand, "send-to");
    const effortWord = readStringFlag(parsedCommand, "effort");
    const settings = {
      ...savedSettings,
      refineProvider: refineProviders.find((name) => name === providerWord) ?? savedSettings.refineProvider,
      refineSendTo: refineSendTargets.find((name) => name === sendToWord) ?? savedSettings.refineSendTo,
      refineCmuxCommand: readStringFlag(parsedCommand, "cmux-command") ?? savedSettings.refineCmuxCommand,
      refineCmuxPressEnter: isFlagOn(parsedCommand, "press-enter") || savedSettings.refineCmuxPressEnter,
    };
    const modelWord = readStringFlag(parsedCommand, "model");
    const refinedPrompt = await refinePrompt({
      draft,
      provider: settings.refineProvider,
      model: modelWord ?? (settings.refineModel || ""),
      effort: effortWord ?? (settings.refineEffort || ""),
      allowPicker: true,
      signal: new AbortController().signal,
      log: () => undefined,
    });
    TerminalUI.printLine(refinedPrompt);
    if (isFlagOn(parsedCommand, "speak")) {
      await speakAloud(refinedPrompt, settings);
    }

    const isSentToCaret = settings.refineSendTo === "caret";
    if (isSentToCaret) {
      return 0;
    }

    const deliveryMessage = await deliverToCmux({ promptText: refinedPrompt, config: settings });
    TerminalUI.printDetail(deliveryMessage);
    return 0;
  },
};
