import path from "node:path";

import { readConfig } from "#src/settings/config-file.js";
import type { Config } from "#src/settings/config-schema.js";
import { makeSpeechPlayer, speakMarkdown, writeMarkdownWav } from "#src/speech/speech-player.js";
import { loadSupertonic } from "#src/speech/supertonic.js";
import { ensureSupertonicModels, listMissingSupertonicFiles } from "#src/speech/supertonic-models.js";
import { type CommandSpec, readRequiredPositional, readStringFlag } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const readVoice = (settings: Config) => ({
  voice: settings.speechVoice,
  wordsPerMinute: settings.speechWordsPerMinute,
});

const loadEngine = async () => {
  const isDownloadNeeded = listMissingSupertonicFiles().length > 0;
  if (isDownloadNeeded) {
    TerminalUI.printStep("Downloading the Supertonic voices (~400 MB, once)");
  }

  const modelFolder = await ensureSupertonicModels(() => undefined);
  return loadSupertonic(modelFolder);
};

export const speakAloud = async (markdown: string, settings: Config): Promise<void> => {
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
  positionals: [{ name: "markdown", description: "A complete reply, in Markdown", isRequired: true }],
  run: async (parsedCommand) => {
    const settings = readConfig();
    const markdown = readRequiredPositional(parsedCommand, "markdown");
    const outputFile = readStringFlag(parsedCommand, "output");

    const isPlaybackOnly = outputFile == null;
    if (isPlaybackOnly) {
      await speakAloud(markdown, settings);
      return 0;
    }

    const engine = await loadEngine();
    const outputPath = path.resolve(outputFile);
    const seconds = await writeMarkdownWav({ engine, markdown, voice: readVoice(settings), outputFile: outputPath });
    TerminalUI.printSuccess(`Wrote ${seconds.toFixed(1)} s of speech to ${outputPath}`);
    return 0;
  },
};
