import path from "node:path";

import { readSettings } from "#src/settings/config-file.js";
import type { Settings } from "#src/settings/config-schema.js";
import { makeSpeechPlayer, speakMarkdown, writeMarkdownWav } from "#src/speech/speech-player.js";
import { loadSupertonic } from "#src/speech/supertonic.js";
import { ensureSupertonicModels, listMissingSupertonicFiles } from "#src/speech/supertonic-models.js";
import { type CommandSpec, readRequiredPositional, readStringFlag } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const MARKDOWN_NAME = "markdown";

const readVoice = (settings: Settings) => ({
  voice: settings.speechVoice,
  wordsPerMinute: settings.speechWordsPerMinute,
});

const loadEngine = async () => {
  const isDownloadNeeded = listMissingSupertonicFiles().length > 0;
  if (isDownloadNeeded) {
    TerminalUI.printStep("Downloading the Supertonic voices (~400 MB, once)");
  }

  const modelFolder = await ensureSupertonicModels(() => {});
  return loadSupertonic(modelFolder);
};

export const speakAloud = async (markdown: string, settings: Settings): Promise<void> => {
  const engine = await loadEngine();
  const player = makeSpeechPlayer();
  const voice = readVoice(settings);
  await speakMarkdown({ engine, player, markdown, voice });
};

export const speakCommand: CommandSpec = {
  name: "speak",
  description: "Read one Markdown reply aloud with the configured voice (or write it to a WAV file)",
  flags: {
    output: { kind: "text", description: "Write the speech to this WAV file instead of playing it" },
  },
  positionals: [{ name: MARKDOWN_NAME, description: "A complete reply, in Markdown", isRequired: true }],
  run: async (parsedCommand) => {
    const settings = readSettings();
    const markdown = readRequiredPositional(parsedCommand, MARKDOWN_NAME);
    const printoutFile = readStringFlag(parsedCommand, "output");

    const isPlaybackOnly = printoutFile == null;
    if (isPlaybackOnly) {
      await speakAloud(markdown, settings);
      return 0;
    }

    const engine = await loadEngine();
    const printoutPath = path.resolve(printoutFile);
    const voiceName = readVoice(settings);
    const seconds = await writeMarkdownWav({ engine, markdown, voice: voiceName, outputFile: printoutPath });
    TerminalUI.printSuccess(`Wrote ${seconds.toFixed(1)} s of speech to ${printoutPath}`);
    return 0;
  },
};
