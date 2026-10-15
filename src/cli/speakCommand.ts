/** `voxkey speak <markdown> [--output file.wav]`: read one reply aloud with the configured voice. */

import path from "node:path";

import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { readConfig } from "../settings/configFile.js";
import { makeSpeechPlayer, renderMarkdownToWav, speakMarkdown } from "../speech/speechPlayer.js";
import { loadSupertonic } from "../speech/supertonic.js";
import { ensureSupertonicModels, missingSupertonicFiles } from "../speech/supertonicModels.js";
import * as TerminalUI from "./TerminalUI.js";

const markdownArgument = Args.text({ name: "markdown" }).pipe(Args.withDescription("A complete reply, in Markdown"));

const outputOption = Options.file("output").pipe(
  Options.withDescription("Write the speech to this WAV file instead of playing it"),
  Options.optional,
);

export const speakCommand = Command.make("speak", { markdown: markdownArgument, output: outputOption }, (args) =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    if (missingSupertonicFiles().length > 0) {
      yield* TerminalUI.step("Downloading the Supertonic voices (~400 MB, once)");
    }
    const engine = yield* loadSupertonic(yield* ensureSupertonicModels(() => undefined));
    const voice = { voice: config.speechVoice, wordsPerMinute: config.speechWordsPerMinute };
    if (Option.isSome(args.output)) {
      const outputFile = path.resolve(args.output.value);
      const seconds = yield* renderMarkdownToWav({ engine, markdown: args.markdown, voice, outputFile });
      yield* TerminalUI.success(`Wrote ${seconds.toFixed(1)} s of speech to ${outputFile}`);
      return;
    }

    yield* speakMarkdown({ engine, player: makeSpeechPlayer(), markdown: args.markdown, voice });
  }),
).pipe(Command.withDescription("Read one Markdown reply aloud with the configured voice (or write it to a WAV file)"));
