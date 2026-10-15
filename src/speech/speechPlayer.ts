import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Fiber, Schema } from "effect";
import { writePrivateFile } from "../files/stateFiles.js";
import { stateFolder } from "../settings/agentVoiceHome.js";
import type { Config } from "../settings/configSchema.js";
import { markdownToSpeech } from "./markdownToSpeech.js";
import { chunkSpeech, SPEECH_CHUNK_CHARACTERS, speedForWordsPerMinute } from "./speechChunks.js";
import type { SupertonicEngine, SupertonicError } from "./supertonic.js";
import { encodeWav } from "./wavFile.js";

export class PlaybackError extends Schema.TaggedError<PlaybackError>()("PlaybackError", {
  issue: Schema.String,
}) {
  get message(): string {
    return `afplay: ${this.issue}`;
  }
}

// One afplay at a time; `stop` kills it at once and makes the current reply end early.
export const makeSpeechPlayer = () => {
  let playing: ChildProcess | undefined;
  let stopped = false;

  const play = (wavFile: string) =>
    Effect.async<void, PlaybackError>((resume) => {
      const child = spawn("afplay", [wavFile], { stdio: "ignore" });
      playing = child;
      child.on("error", (error) => {
        const playbackError = new PlaybackError({ issue: error.message });
        const failure = Effect.fail(playbackError);
        resume(failure);
      });
      child.on("exit", () => {
        playing = undefined;
        resume(Effect.void);
      });
      return Effect.sync(() => child.kill("SIGKILL"));
    });

  const stop = () => {
    stopped = true;
    playing?.kill("SIGKILL");
  };

  const reset = () => {
    stopped = false;
  };

  return { play, stop, reset, isStopped: () => stopped };
};

export type SpeechPlayer = ReturnType<typeof makeSpeechPlayer>;

type Voice = { readonly voice: Config["speechVoice"]; readonly wordsPerMinute: number };

const speechPieces = (markdown: string): ReadonlyArray<string> => {
  const speech = markdownToSpeech(markdown);
  return chunkSpeech(speech, SPEECH_CHUNK_CHARACTERS);
};

const pieceRenderer = (engine: SupertonicEngine, voice: Voice) => {
  const speed = speedForWordsPerMinute(voice.wordsPerMinute);
  return (text: string) => engine.synthesize({ text, voice: voice.voice, speed });
};

const chunkFile = (index: number): string => {
  const audioFolder = stateFolder("audio");
  return path.join(audioFolder, `speech-${process.pid}-${index % 2}.wav`);
};

// The next piece renders while the current one plays, so the first words start quickly.
export const speakMarkdown = (request: {
  readonly engine: SupertonicEngine;
  readonly player: SpeechPlayer;
  readonly markdown: string;
  readonly voice: Voice;
}): Effect.Effect<"completed" | "stopped", SupertonicError | PlaybackError> =>
  Effect.gen(function* () {
    const pieces = speechPieces(request.markdown);
    const render = pieceRenderer(request.engine, request.voice);
    const renderInBackground = (index: number) => {
      const rendering = render(pieces[index] || "");
      return Effect.fork(rendering);
    };
    let next = yield* renderInBackground(0);
    for (const index of pieces.keys()) {
      const samples = yield* Fiber.join(next);
      if (request.player.isStopped()) {
        return "stopped";
      }

      next = yield* renderInBackground(index + 1);
      const file = chunkFile(index);
      const wav = encodeWav({ samples, sampleRate: request.engine.sampleRate });
      // A chunk is the reply spoken aloud, so it is as private as the reply's text.
      writePrivateFile({ path: file, flags: "w", contents: wav });
      yield* request.player.play(file);
    }
    yield* Fiber.interrupt(next);
    if (request.player.isStopped()) {
      return "stopped";
    }

    return "completed";
  });

// Returns the length of the WAV file in seconds.
export const renderMarkdownToWav = (request: {
  readonly engine: SupertonicEngine;
  readonly markdown: string;
  readonly voice: Voice;
  readonly outputFile: string;
}): Effect.Effect<number, SupertonicError> =>
  Effect.gen(function* () {
    const pieces = speechPieces(request.markdown);
    const render = pieceRenderer(request.engine, request.voice);
    const chunks = yield* Effect.forEach(pieces, render);
    const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const samples = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    const wav = encodeWav({ samples, sampleRate: request.engine.sampleRate });
    const outputFolder = path.dirname(request.outputFile);
    mkdirSync(outputFolder, { recursive: true });
    writeFileSync(request.outputFile, wav);
    return samples.length / request.engine.sampleRate;
  });
