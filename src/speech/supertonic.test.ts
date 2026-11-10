import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readSamplesFromPcm } from "#src/dictation/clip-audio.js";
import { loadTranscriber } from "#src/dictation/transcriber.js";
import { makeTestFolder } from "#src/testing/test-folder.js";
import { writeMarkdownWav } from "./speech-player.js";
import { loadSupertonic } from "./supertonic.js";
import { decodeWav } from "./wav-file.js";

// Smoke tests only read the models already in ~/.agent-voice/models and never download them.
const home = homedir();
const modelsFolder = path.join(home, ".agent-voice", "models");
const supertonicModelFolder = path.join(modelsFolder, "supertonic-3");
const vocoderFile = path.join(supertonicModelFolder, "onnx", "vocoder.onnx");
const hasSupertonic = existsSync(vocoderFile);

const findWhisperModel = (): string | undefined => {
  const isModelsFolderAbsent = !existsSync(modelsFolder);
  if (isModelsFolderAbsent) {
    return undefined;
  }

  const modelName = readdirSync(modelsFolder).find((name) => name.startsWith("ggml-") && name.endsWith(".bin"));

  const isModelNameMissing = modelName === undefined;
  if (isModelNameMissing) {
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
    const printoutFile = path.join(folder, "reply.wav");
    const engine = await loadSupertonic(supertonicModelFolder);
    const seconds = await writeMarkdownWav({
      engine,
      markdown: "# Release\n\nThe voice worker is **ready**.",
      voice: { voice: "F4", wordsPerMinute: 230 },
      outputFile: printoutFile,
    });
    const renderedBytes = readFileSync(printoutFile);
    const rendered = decodeWav(renderedBytes);

    expect(seconds).toBeGreaterThan(1);
    expect(rendered?.sampleRate).toBe(44_100);

    const isWhisperModelMissing = whisperModel === undefined;
    if (isWhisperModelMissing) {
      return;
    }

    const resampledFile = path.join(folder, "reply-16k.wav");
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", printoutFile, resampledFile]);
    const resampledBytes = readFileSync(resampledFile);
    const resampled = decodeWav(resampledBytes);
    const samples = readSamplesFromPcm(resampled?.pcm || new Int16Array());
    const transcriber = await loadTranscriber(whisperModel);
    const transcription = await transcriber.transcribe({ samples, language: "en", prompt: "" });
    await transcriber.release();
    const heard = transcription.text.toLowerCase();

    expect(heard).toContain("release");
    expect(heard).toContain("ready");
  });
});
