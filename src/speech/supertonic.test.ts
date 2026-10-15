import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { samplesFromPcm } from "../dictation/speechDetection.js";
import { loadTranscriber } from "../dictation/transcriber.js";
import { renderMarkdownToWav } from "./speechPlayer.js";
import { loadSupertonic } from "./supertonic.js";
import { decodeWav } from "./wavFile.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Smoke tests use models already on this Mac (in .scratch/models or ~/.voxkey/models) and never download them.
const modelFolders = [path.join(repositoryRoot, ".scratch", "models"), path.join(homedir(), ".voxkey", "models")];

const supertonicFolder = modelFolders
  .map((folder) => path.join(folder, "supertonic-3"))
  .find((folder) => existsSync(path.join(folder, "onnx", "vocoder.onnx")));

const whisperModel = modelFolders
  .map((folder) => path.join(folder, "ggml-base.en.bin"))
  .find((candidate) => existsSync(candidate));

const scratch = path.join(repositoryRoot, ".scratch");
mkdirSync(scratch, { recursive: true });
const folder = mkdtempSync(path.join(scratch, "supertonic-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe.skipIf(supertonicFolder === undefined)("Supertonic speech (smoke)", () => {
  it("renders a Markdown reply to a 44.1 kHz WAV file, and Whisper hears the same words", async () => {
    const outputFile = path.join(folder, "reply.wav");
    const seconds = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* loadSupertonic(supertonicFolder || "");
        return yield* renderMarkdownToWav({
          engine,
          markdown: "# Release\n\nThe voice worker is **ready**.",
          voice: { voice: "F4", wordsPerMinute: 230 },
          outputFile,
        });
      }),
    );

    expect(seconds).toBeGreaterThan(1);
    expect(decodeWav(readFileSync(outputFile))?.sampleRate).toBe(44_100);
    if (whisperModel === undefined) {
      return;
    }

    const resampled = path.join(folder, "reply-16k.wav");
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", outputFile, resampled]);
    const heard = await Effect.runPromise(
      Effect.gen(function* () {
        const transcriber = yield* loadTranscriber(whisperModel);
        const decoded = decodeWav(readFileSync(resampled));
        const transcription = yield* transcriber.transcribe({
          samples: samplesFromPcm(decoded?.pcm || new Int16Array()),
          language: "en",
          prompt: "",
        });
        yield* transcriber.release;
        return transcription.text.toLowerCase();
      }),
    );
    expect(heard).toContain("release");
    expect(heard).toContain("ready");
  });
});
