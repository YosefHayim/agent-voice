import path from "node:path";

import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { readConfig } from "../settings/configFile.js";
import type { Config } from "../settings/configSchema.js";
import { makeSpeechPlayer, renderMarkdownToWav, speakMarkdown } from "../speech/speechPlayer.js";
import { loadSupertonic } from "../speech/supertonic.js";
import { ensureSupertonicModels, missingSupertonicFiles } from "../speech/supertonicModels.js";
import * as TerminalUI from "./TerminalUI.js";

const voiceOf = (config: Config) => ({ voice: config.speechVoice, wordsPerMinute: config.speechWordsPerMinute });

const loadEngine = Effect.gen(function* () {
  const isDownloadNeeded = missingSupertonicFiles().length > 0;
  if (isDownloadNeeded) {
    yield* TerminalUI.step("Downloading the Supertonic voices (~400 MB, once)");
  }

  const modelFolder = yield* ensureSupertonicModels(() => undefined);
  return yield* loadSupertonic(modelFolder);
});

export const speakAloud = (markdown: string, config: Config) =>
  Effect.gen(function* () {
    const engine = yield* loadEngine;
    const player = makeSpeechPlayer();
    const voice = voiceOf(config);
    yield* speakMarkdown({ engine, player, markdown, voice });
  });

const markdownArgument = Args.text({ name: "markdown" }).pipe(Args.withDescription("A complete reply, in Markdown"));

const outputOption = Options.file("output").pipe(
  Options.withDescription("Write the speech to this WAV file instead of playing it"),
  Options.optional,
);

export const speakCommand = Command.make("speak", { markdown: markdownArgument, output: outputOption }, (args) =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    if (Option.isNone(args.output)) {
      return yield* speakAloud(args.markdown, config);
    }

    const engine = yield* loadEngine;
    const voice = voiceOf(config);
    const outputFile = path.resolve(args.output.value);
    const seconds = yield* renderMarkdownToWav({ engine, markdown: args.markdown, voice, outputFile });
    yield* TerminalUI.success(`Wrote ${seconds.toFixed(1)} s of speech to ${outputFile}`);
  }),
).pipe(Command.withDescription("Read one Markdown reply aloud with the configured voice (or write it to a WAV file)"));
