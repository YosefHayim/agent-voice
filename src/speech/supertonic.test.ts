import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { samplesFromPcm } from "../dictation/clipAudio.js";
import { loadTranscriber } from "../dictation/transcriber.js";
import { makeTestFolder } from "../scripts/testFolder.js";
import { renderMarkdownToWav } from "./speechPlayer.js";
import { loadSupertonic } from "./supertonic.js";
import { decodeWav } from "./wavFile.js";

// Smoke tests only read the models already in ~/.agent-voice/models and never download them.
const home = homedir();
const modelsFolder = path.join(home, ".agent-voice", "models");
const supertonicModelFolder = path.join(modelsFolder, "supertonic-3");
const vocoderFile = path.join(supertonicModelFolder, "onnx", "vocoder.onnx");
const hasSupertonic = existsSync(vocoderFile);

const findWhisperModel = (): string | undefined => {
  if (!existsSync(modelsFolder)) {
    return undefined;
  }

  const modelName = readdirSync(modelsFolder).find((name) => name.startsWith("ggml-") && name.endsWith(".bin"));
  if (modelName === undefined) {
    return undefined;
  }

  return path.join(modelsFolder, modelName);
};

const whisperModel = findWhisperModel();

describe.skipIf(!hasSupertonic)("Supertonic speech (smoke)", () => {
  let folder = "";

  beforeAll(() => {
    folder = makeTestFolder("supertonic");
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("renders a Markdown reply to a 44.1 kHz WAV file, and Whisper hears the same words", async () => {
    const outputFile = path.join(folder, "reply.wav");
    const rendering = Effect.gen(function* () {
      const engine = yield* loadSupertonic(supertonicModelFolder);
      return yield* renderMarkdownToWav({
        engine,
        markdown: "# Release\n\nThe voice worker is **ready**.",
        voice: { voice: "F4", wordsPerMinute: 230 },
        outputFile,
      });
    });
    const seconds = await Effect.runPromise(rendering);
    const renderedBytes = readFileSync(outputFile);
    const rendered = decodeWav(renderedBytes);

    expect(seconds).toBeGreaterThan(1);
    expect(rendered?.sampleRate).toBe(44_100);
    if (whisperModel === undefined) {
      return;
    }

    const resampledFile = path.join(folder, "reply-16k.wav");
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", outputFile, resampledFile]);
    const resampledBytes = readFileSync(resampledFile);
    const resampled = decodeWav(resampledBytes);
    const samples = samplesFromPcm(resampled?.pcm || new Int16Array());
    const hearing = Effect.gen(function* () {
      const transcriber = yield* loadTranscriber(whisperModel);
      const transcription = yield* transcriber.transcribe({ samples, language: "en", prompt: "" });
      yield* transcriber.release;
      return transcription.text.toLowerCase();
    });
    const heard = await Effect.runPromise(hearing);

    expect(heard).toContain("release");
    expect(heard).toContain("ready");
  });
});
