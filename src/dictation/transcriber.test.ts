import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { decodeWav } from "../speech/wavFile.js";
import { formatDictation } from "./dictationFormat.js";
import { samplesFromPcm } from "./speechDetection.js";
import { loadTranscriber } from "./transcriber.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Smoke tests use a model already on this Mac (in .scratch/models or ~/.voxkey/models) and never download one.
const modelFile = [
  path.join(repositoryRoot, ".scratch", "models", "ggml-base.en.bin"),
  path.join(homedir(), ".voxkey", "models", "ggml-base.en.bin"),
].find((candidate) => existsSync(candidate));

const scratch = path.join(repositoryRoot, ".scratch");
mkdirSync(scratch, { recursive: true });
const folder = mkdtempSync(path.join(scratch, "whisper-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** A spoken fixture made with macOS `say`, converted to 16 kHz mono 16-bit PCM with `afconvert`. */
const spokenFixture = (text: string): Float32Array => {
  const aiff = path.join(folder, "spoken.aiff");
  const wav = path.join(folder, "spoken.wav");
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const decoded = decodeWav(readFileSync(wav));
  if (decoded === undefined || decoded.sampleRate !== 16_000) throw new Error("afconvert did not write 16 kHz PCM");
  return samplesFromPcm(decoded.pcm);
};

describe.skipIf(modelFile === undefined || process.platform !== "darwin")("Whisper transcription (smoke)", () => {
  it("transcribes a spoken WAV fixture and formats it for the caret", async () => {
    const transcription = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transcriber = yield* loadTranscriber(modelFile || "");
          yield* transcriber.warm;
          const spoken = yield* transcriber.transcribe({
            samples: spokenFixture("Check the worktrees folder and push every branch."),
            language: "en",
            prompt: "worktrees",
          });
          yield* transcriber.release;
          return spoken;
        }),
      ),
    );

    expect(transcription.ranWhisper).toBe(true);
    expect(transcription.text.toLowerCase()).toMatch(/folder.*push every/u);
    expect(formatDictation(transcription.text, new Map()).endsWith(" ")).toBe(true);
  });

  it("skips Whisper for silence and types nothing", async () => {
    const silence = await Effect.runPromise(
      Effect.gen(function* () {
        const transcriber = yield* loadTranscriber(modelFile || "");
        const decoded = yield* transcriber.transcribe({
          samples: new Float32Array(16_000),
          language: "en",
          prompt: "",
        });
        yield* transcriber.release;
        return decoded;
      }),
    );

    expect(silence).toMatchObject({ text: "", ranWhisper: false });
  });
});
