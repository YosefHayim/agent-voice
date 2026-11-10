import { convertMarkdownToSpeech } from "#src/speech/markdown-to-speech.js";
import { type CommandSpec, readRequiredPositional } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const MARKDOWN_NAME = "markdown";

export const renderCommand: CommandSpec = {
  name: "render",
  description: "Print the sentences agent-voice would read for a Markdown reply",
  flags: {},
  positionals: [{ name: MARKDOWN_NAME, description: "A complete reply, in Markdown", isRequired: true }],
  run: async (parsedCommand) => {
    const markdown = readRequiredPositional(parsedCommand, MARKDOWN_NAME);
    const speech = convertMarkdownToSpeech(markdown);
    TerminalUI.printLine(speech);
    return 0;
  },
};
