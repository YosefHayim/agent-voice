/**
 * Speak Markdown: render it to speech text, synthesize 280-character chunks, and play each with
 * `afplay` while the next one renders, so the first words start quickly. Stopping kills playback at once.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Fiber, Schema } from "effect";
import { writePrivateFile } from "../files/stateFiles.js";
import type { Config } from "../settings/configSchema.js";
import { stateFolder } from "../settings/voxkeyHome.js";
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

/** One afplay at a time; `stop` kills it and makes the current reply end early. */
export const makeSpeechPlayer = () => {
  let playing: ChildProcess | undefined;
  let stopped = false;

  const play = (wavFile: string) =>
    Effect.async<void, PlaybackError>((resume) => {
      const child = spawn("afplay", [wavFile], { stdio: "ignore" });
      playing = child;
      child.on("error", (error) => resume(Effect.fail(new PlaybackError({ issue: error.message }))));
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

  return { play, stop, reset, isStopped: () => stopped, isPlaying: () => playing !== undefined };
};

export type SpeechPlayer = ReturnType<typeof makeSpeechPlayer>;

type Voice = { readonly voice: Config["speechVoice"]; readonly wordsPerMinute: number };

const speechPieces = (markdown: string): ReadonlyArray<string> =>
  chunkSpeech(markdownToSpeech(markdown), SPEECH_CHUNK_CHARACTERS);

const chunkFile = (index: number): string =>
  path.join(stateFolder("audio"), `speech-${String(process.pid)}-${String(index % 2)}.wav`);

/** Play a reply chunk by chunk; "stopped" when the player was stopped before the end. */
export const speakMarkdown = (request: {
  readonly engine: SupertonicEngine;
  readonly player: SpeechPlayer;
  readonly markdown: string;
  readonly voice: Voice;
}): Effect.Effect<"completed" | "stopped", SupertonicError | PlaybackError> =>
  Effect.gen(function* () {
    const pieces = speechPieces(request.markdown);
    const speed = speedForWordsPerMinute(request.voice.wordsPerMinute);
    const render = (text: string) => request.engine.synthesize({ text, voice: request.voice.voice, speed });
    let next = yield* Effect.fork(render(pieces[0] || ""));
    for (let index = 0; index < pieces.length; index += 1) {
      const samples = yield* Fiber.join(next);
      if (request.player.isStopped()) {
        return "stopped";
      }

      next = yield* Effect.fork(render(pieces[index + 1] || ""));
      const file = chunkFile(index);
      // A chunk is the reply spoken aloud, so it is as private as the reply's text.
      writePrivateFile({
        path: file,
        flags: "w",
        contents: encodeWav({ samples, sampleRate: request.engine.sampleRate }),
      });
      yield* request.player.play(file);
    }
    yield* Fiber.interrupt(next);
    return request.player.isStopped() ? "stopped" : "completed";
  });

/** Render a whole reply to one WAV file instead of playing it. */
export const renderMarkdownToWav = (request: {
  readonly engine: SupertonicEngine;
  readonly markdown: string;
  readonly voice: Voice;
  readonly outputFile: string;
}): Effect.Effect<number, SupertonicError> =>
  Effect.gen(function* () {
    const speed = speedForWordsPerMinute(request.voice.wordsPerMinute);
    const chunks = yield* Effect.forEach(speechPieces(request.markdown), (text) =>
      request.engine.synthesize({ text, voice: request.voice.voice, speed }),
    );
    const samples = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    mkdirSync(path.dirname(request.outputFile), { recursive: true });
    writeFileSync(request.outputFile, encodeWav({ samples, sampleRate: request.engine.sampleRate }));
    return samples.length / request.engine.sampleRate;
  });
