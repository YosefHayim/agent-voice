/** `voxkey render <markdown>`: print the sentences voxkey would read for a reply, without speaking. */

import { Args, Command } from "@effect/cli";

import { markdownToSpeech } from "../speech/markdownToSpeech.js";
import * as TerminalUI from "./TerminalUI.js";

export const renderCommand = Command.make(
  "render",
  { markdown: Args.text({ name: "markdown" }).pipe(Args.withDescription("A complete reply, in Markdown")) },
  (args) => TerminalUI.text(markdownToSpeech(args.markdown)),
).pipe(Command.withDescription("Print the sentences voxkey would read for a Markdown reply"));
