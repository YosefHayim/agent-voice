import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { stateFolder } from "#src/settings/agent-voice-home.js";
import type { Config } from "#src/settings/config-schema.js";
import { writePrivateFile } from "#src/storage/state-files.js";
import { markdownToSpeech } from "./markdown-to-speech.js";
import { chunkSpeech, SPEECH_CHUNK_CHARACTERS, speedForWordsPerMinute } from "./speech-chunks.js";
import type { SupertonicEngine } from "./supertonic.js";
import { encodeWav } from "./wav-file.js";

// One afplay at a time; `stop` kills it at once and makes the current reply end early.
export const makeSpeechPlayer = () => {
  let playing: ChildProcess | undefined;
  let stopped = false;

  const play = (wavFile: string): Promise<void> =>
    new Promise<void>((finish, fail) => {
      const child = spawn("afplay", [wavFile], { stdio: "ignore" });
      playing = child;
      child.on("error", (error) => {
        fail(new Error(`afplay: ${error.message}`, { cause: error }));
      });
      child.on("exit", () => {
        playing = undefined;
        finish();
      });
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

const pieceSynthesizer = (engine: SupertonicEngine, voice: Voice) => {
  const speed = speedForWordsPerMinute(voice.wordsPerMinute);
  return (text: string) => engine.synthesize({ text, voice: voice.voice, speed });
};

const chunkFile = (index: number): string => {
  const audioFolder = stateFolder("audio");
  return path.join(audioFolder, `speech-${process.pid}-${index % 2}.wav`);
};

// The next piece renders while the current one plays, so the first words start quickly.
export const speakMarkdown = async (request: {
  readonly engine: SupertonicEngine;
  readonly player: SpeechPlayer;
  readonly markdown: string;
  readonly voice: Voice;
}): Promise<"completed" | "stopped"> => {
  const pieces = speechPieces(request.markdown);
  const synthesize = pieceSynthesizer(request.engine, request.voice);
  const synthesizePiece = (index: number) => synthesize(pieces[index] || "");

  // Always awaited before this function returns, so no render is left running after a stop or an error.
  let pendingRender = synthesizePiece(0);
  try {
    for (const index of pieces.keys()) {
      const samples = await pendingRender;

      const isStoppedBeforePlay = request.player.isStopped();
      if (isStoppedBeforePlay) {
        return "stopped";
      }

      const hasNextPiece = index + 1 < pieces.length;
      if (hasNextPiece) {
        pendingRender = synthesizePiece(index + 1);
      }

      const file = chunkFile(index);
      const wav = encodeWav({ samples, sampleRate: request.engine.sampleRate });
      // A chunk is the reply spoken aloud, so it is as private as the reply's text.
      writePrivateFile({ path: file, flags: "w", contents: wav });
      await request.player.play(file);
    }
  } finally {
    await pendingRender;
  }

  const isStoppedAtEnd = request.player.isStopped();
  if (isStoppedAtEnd) {
    return "stopped";
  }

  return "completed";
};

// Returns the length of the WAV file in seconds.
export const writeMarkdownWav = async (request: {
  readonly engine: SupertonicEngine;
  readonly markdown: string;
  readonly voice: Voice;
  readonly outputFile: string;
}): Promise<number> => {
  const pieces = speechPieces(request.markdown);
  const synthesize = pieceSynthesizer(request.engine, request.voice);
  const chunks: Float32Array[] = [];
  for (const piece of pieces) {
    const chunk = await synthesize(piece);
    chunks.push(chunk);
  }

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
};
