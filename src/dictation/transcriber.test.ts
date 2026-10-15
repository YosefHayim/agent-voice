import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { decodeWav } from "../speech/wavFile.js";
import { samplesFromPcm } from "./clipAudio.js";
import { formatDictation } from "./dictationFormat.js";
import { loadTranscriber } from "./transcriber.js";

// Smoke tests only read a Whisper model already in ~/.voxkey/models and never download one.
const userHome = homedir();
const modelsFolder = path.join(userHome, ".voxkey", "models");

const installedModel = (): string | undefined => {
  if (!existsSync(modelsFolder)) {
    return undefined;
  }

  const modelName = readdirSync(modelsFolder).find((file) => /^ggml-.*\.bin$/u.test(file));
  if (modelName === undefined) {
    return undefined;
  }

  return path.join(modelsFolder, modelName);
};

const modelFile = installedModel();

const folder = makeTestFolder("whisper");
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const spokenFixture = (text: string): Float32Array => {
  const aiff = path.join(folder, "spoken.aiff");
  const wav = path.join(folder, "spoken.wav");
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const wavBytes = readFileSync(wav);
  const decoded = decodeWav(wavBytes);
  if (decoded === undefined || decoded.sampleRate !== 16_000) {
    throw new Error("afconvert did not write 16 kHz PCM");
  }

  return samplesFromPcm(decoded.pcm);
};

describe.skipIf(modelFile === undefined || process.platform !== "darwin")("Whisper transcription (smoke)", () => {
  const modelPath = modelFile || "";

  it("transcribes a spoken WAV fixture and formats it for the caret", async () => {
    const samples = spokenFixture("Check the worktrees folder and push every branch.");
    const transcribeSpoken = Effect.gen(function* () {
      const transcriber = yield* loadTranscriber(modelPath);
      yield* transcriber.warm;
      const spoken = yield* transcriber.transcribe({ samples, language: "en", prompt: "worktrees" });
      yield* transcriber.release;
      return spoken;
    });

    const transcription = await Effect.runPromise(transcribeSpoken);
    const formatted = formatDictation(transcription.text, new Map());

    expect(transcription.ranWhisper).toBe(true);
    expect(transcription.text.toLowerCase()).toMatch(/folder.*push every/u);
    expect(formatted.endsWith(" ")).toBe(true);
  });

  it("skips Whisper for silence and types nothing", async () => {
    const transcribeSilence = Effect.gen(function* () {
      const transcriber = yield* loadTranscriber(modelPath);
      const decoded = yield* transcriber.transcribe({ samples: new Float32Array(16_000), language: "en", prompt: "" });
      yield* transcriber.release;
      return decoded;
    });

    const silence = await Effect.runPromise(transcribeSilence);

    expect(silence).toMatchObject({ text: "", ranWhisper: false });
  });
});
