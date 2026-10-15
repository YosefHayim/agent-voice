import { Args, Command } from "@effect/cli";

import { markdownToSpeech } from "../speech/markdownToSpeech.js";
import * as TerminalUI from "./TerminalUI.js";

const markdownArgument = Args.text({ name: "markdown" }).pipe(Args.withDescription("A complete reply, in Markdown"));

export const renderCommand = Command.make("render", { markdown: markdownArgument }, (args) => {
  const speech = markdownToSpeech(args.markdown);
  return TerminalUI.text(speech);
}).pipe(Command.withDescription("Print the sentences agent-voice would read for a Markdown reply"));
