import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeWav } from "#src/speech/wav-file.js";
import { makeTestFolder } from "#src/testing/test-folder.js";
import { readSamplesFromPcm } from "./clip-audio.js";
import { createDictationTranscript } from "./dictation-format.js";
import { loadTranscriber } from "./transcriber.js";

// Smoke tests only read a Whisper model already in ~/.agent-voice/models and never download one.
const userHome = homedir();
const modelsFolder = path.join(userHome, ".agent-voice", "models");

const readInstalledModel = (): string | undefined => {
  const isModelsFolderAbsent = !existsSync(modelsFolder);
  if (isModelsFolderAbsent) {
    return undefined;
  }

  const modelName = readdirSync(modelsFolder).find((file) => /^ggml-.*\.bin$/u.test(file));

  const isModelNameMissing = modelName == null;
  if (isModelNameMissing) {
    return undefined;
  }

  return path.join(modelsFolder, modelName);
};

const modelFile = readInstalledModel();

describe.skipIf(modelFile == null || process.platform !== "darwin")("Whisper transcription (smoke)", () => {
  const modelPath = modelFile || "";
  let folder = "";

  beforeAll(() => {
    folder = makeTestFolder("whisper");
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const readSpokenFixture = (string: string): Float32Array => {
    const aiff = path.join(folder, "spoken.aiff");
    const wav = path.join(folder, "spoken.wav");
    execFileSync("say", ["-o", aiff, string]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    const wavBytes = readFileSync(wav);

    const decoded = decodeWav(wavBytes);

    const whisperSampleRate = 16_000;
    const isNotWhisperAudio = decoded == null || decoded.sampleRate !== whisperSampleRate;
    if (isNotWhisperAudio) {
      throw new Error("afconvert did not write 16 kHz PCM");
    }

    return readSamplesFromPcm(decoded.pcm);
  };

  it("transcribes a spoken WAV fixture and formats it for the caret", async () => {
    const samples = readSpokenFixture("Check the worktrees folder and push every branch.");
    const transcriber = await loadTranscriber(modelPath);
    await transcriber.warmUp();
    const transcription = await transcriber.transcribe({ samples, language: "en", prompt: "worktrees" });
    await transcriber.release();
    const formatted = createDictationTranscript(transcription.text, new Map());

    expect(transcription.ranWhisper).toBe(true);
    expect(transcription.text.toLowerCase()).toMatch(/folder.*push every/u);
    expect(formatted.endsWith(" ")).toBe(true);
  });

  it("skips Whisper for silence and types nothing", async () => {
    const transcriber = await loadTranscriber(modelPath);
    const silence = await transcriber.transcribe({ samples: new Float32Array(16_000), language: "en", prompt: "" });
    await transcriber.release();

    expect(silence).toMatchObject({ text: "", ranWhisper: false });
  });
});
