import path from "node:path";

import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { readConfig } from "#src/settings/config-file.js";
import type { Config } from "#src/settings/config-schema.js";
import { makeSpeechPlayer, speakMarkdown, writeMarkdownWav } from "#src/speech/speech-player.js";
import { loadSupertonic } from "#src/speech/supertonic.js";
import { ensureSupertonicModels, missingSupertonicFiles } from "#src/speech/supertonic-models.js";
import * as TerminalUI from "./terminal-ui.js";

const voiceOf = (config: Config) => ({ voice: config.speechVoice, wordsPerMinute: config.speechWordsPerMinute });

const loadEngine = Effect.gen(function* () {
  const isDownloadNeeded = missingSupertonicFiles().length > 0;
  if (isDownloadNeeded) {
    yield* TerminalUI.step("Downloading the Supertonic voices (~400 MB, once)");
  }

  const modelFolder = yield* Effect.tryPromise({
    try: () => ensureSupertonicModels(() => undefined),
    catch: (error) => error,
  });
  return yield* Effect.tryPromise({ try: () => loadSupertonic(modelFolder), catch: (error) => error });
});

export const speakAloud = (markdown: string, config: Config) =>
  Effect.gen(function* () {
    const engine = yield* loadEngine;
    const player = makeSpeechPlayer();
    const voice = voiceOf(config);
    yield* Effect.tryPromise({
      try: () => speakMarkdown({ engine, player, markdown, voice }),
      catch: (error) => error,
    });
  });

const markdownArgument = Args.text({ name: "markdown" }).pipe(Args.withDescription("A complete reply, in Markdown"));

const outputOption = Options.file("output").pipe(
  Options.withDescription("Write the speech to this WAV file instead of playing it"),
  Options.optional,
);

export const speakCommand = Command.make("speak", { markdown: markdownArgument, output: outputOption }, (args) =>
  Effect.gen(function* () {
    const config = yield* Effect.try({ try: readConfig, catch: (error) => error });
    if (Option.isNone(args.output)) {
      return yield* speakAloud(args.markdown, config);
    }

    const engine = yield* loadEngine;
    const voice = voiceOf(config);
    const outputFile = path.resolve(args.output.value);
    const seconds = yield* Effect.tryPromise({
      try: () => writeMarkdownWav({ engine, markdown: args.markdown, voice, outputFile }),
      catch: (error) => error,
    });
    yield* TerminalUI.success(`Wrote ${seconds.toFixed(1)} s of speech to ${outputFile}`);
  }),
).pipe(Command.withDescription("Read one Markdown reply aloud with the configured voice (or write it to a WAV file)"));
