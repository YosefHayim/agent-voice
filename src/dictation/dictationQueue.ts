// A release only enqueues its clip, and one fiber decodes, refines, and delivers clips in order, so the next
// hold can start while the previous clip decodes. Text is typed once and never erased and retyped, because the
// caret may have moved by the time a model answers.

import { Effect, Either, Fiber, Option, Queue } from "effect";
import { deliverToCmux } from "../refine/cmuxDelivery.js";
import { refinePrompt } from "../refine/refineAttempts.js";
import { readConfigOrDefaults } from "../settings/configFile.js";
import type { Config } from "../settings/configSchema.js";
import { appendDictationLog } from "../workers/workerLog.js";
import type { StatusWriter } from "../workers/workerStatus.js";
import { typeAtCaret } from "./caret.js";
import { SAMPLE_RATE } from "./clipAudio.js";
import { formatDictation, parseReplacements, promptBoost } from "./dictationFormat.js";
import type { Keyboard } from "./keyboard.js";
import type { Transcriber } from "./transcriber.js";
import { cleanTranscript, isShortPhrase } from "./transcriptText.js";

type DictationJob = {
  readonly samples: Float32Array;
  // Typed when the final decode hears nothing, which happens on short clips.
  readonly fallbackCaption: string;
  readonly generation: number;
};

type Pipeline = { readonly transcriber: Transcriber; readonly keyboard: Keyboard; readonly status: StatusWriter };

type Prompt = { readonly text: string; readonly refined: boolean };

// Typing waits this long for a refined prompt, then types what was dictated.
const REFINE_WAIT = "20 seconds";

const isDictationRefine = (config: Config) => config.refineMode === "dictation" || config.refineMode === "both";

const refineLabel = (config: Config): string => {
  const model = config.refineModel || "default model";
  if (config.refineEffort === undefined) {
    return `${config.refineProvider}/${model}`;
  }

  return `${config.refineProvider}/${model}/${config.refineEffort}`;
};

// A refine slower than REFINE_WAIT keeps running in the background, so a picker choice is still saved.
const refinedOrDictated = (request: {
  readonly pipeline: Pipeline;
  readonly config: Config;
  readonly dictated: string;
  readonly generation: number;
}) =>
  Effect.gen(function* () {
    const generation = String(request.generation);
    const dictatedPrompt: Prompt = { text: request.dictated, refined: false };
    if (!isDictationRefine(request.config)) {
      return dictatedPrompt;
    }

    if (isShortPhrase(request.dictated)) {
      appendDictationLog(`refine skipped gen=${generation}: short phrase`);
      return dictatedPrompt;
    }

    const label = refineLabel(request.config);
    request.pipeline.status.write("refining", `Refining (${label})…`);
    const started = performance.now();
    const refine = yield* refinePrompt({
      draft: request.dictated,
      provider: request.config.refineProvider,
      model: request.config.refineModel || "",
      effort: request.config.refineEffort || "",
      allowPicker: true,
      log: appendDictationLog,
    }).pipe(Effect.forkDaemon);
    const refined = yield* Fiber.join(refine).pipe(Effect.timeout(REFINE_WAIT), Effect.either);
    const elapsed = (performance.now() - started).toFixed(0);
    const keepDictation = (why: string): Prompt => {
      appendDictationLog(`refine kept dictation gen=${generation} after ${elapsed} ms: ${why}`);
      return dictatedPrompt;
    };
    if (Either.isLeft(refined)) {
      return keepDictation(refined.left.message);
    }

    if (refined.right.trim() === "") {
      return keepDictation("empty reply");
    }

    appendDictationLog(`refine gen=${generation} refine_ms=${elapsed} refined=${JSON.stringify(refined.right)}`);
    return { text: refined.right, refined: true };
  });

const typeDictation = (request: { readonly pipeline: Pipeline; readonly config: Config; readonly text: string }) =>
  Effect.gen(function* () {
    const replacements = parseReplacements(request.config.dictationReplacements);
    const formatted = formatDictation(request.text, replacements);
    yield* typeAtCaret({
      keyboard: request.pipeline.keyboard,
      text: formatted,
      pressEnter: request.config.refinePressEnter,
    });
    if (!request.config.refinePressEnter) {
      return formatted;
    }

    return `${formatted} [Enter]`;
  });

// Dictated text, and a refined prompt whose cmux delivery failed, are typed at the caret.
const deliver = (request: { readonly pipeline: Pipeline; readonly config: Config; readonly prompt: Prompt }) => {
  const typed = typeDictation({ pipeline: request.pipeline, config: request.config, text: request.prompt.text });
  const goesToCmux = request.prompt.refined && request.config.refineSendTo !== "caret";
  if (!goesToCmux) {
    return typed;
  }

  return deliverToCmux({ text: request.prompt.text, config: request.config }).pipe(
    Effect.catchAll((failure) => {
      appendDictationLog(`cmux delivery failed: ${failure.message}; typing at the caret`);
      return typed;
    }),
  );
};

const noSpeechDetail = (request: { readonly seconds: string; readonly ranWhisper: boolean }): string => {
  if (request.ranWhisper) {
    return `No speech (${request.seconds}s audio)`;
  }

  return `No speech (${request.seconds}s, silence)`;
};

const processJob = (pipeline: Pipeline, job: DictationJob) =>
  Effect.gen(function* () {
    const generation = String(job.generation);
    const seconds = (job.samples.length / SAMPLE_RATE).toFixed(2);
    pipeline.status.write("finishing", `Decoding ${String(job.samples.length)} samples…`);
    const config = yield* readConfigOrDefaults;
    const started = performance.now();
    const replacements = parseReplacements(config.dictationReplacements);
    const transcription = yield* pipeline.transcriber.transcribe({
      samples: job.samples,
      language: config.dictationLanguage,
      prompt: promptBoost(replacements),
    });
    const dictated = cleanTranscript(transcription.text) || cleanTranscript(job.fallbackCaption);
    const decodeMs = transcription.decodeMs.toFixed(1);
    const level = transcription.inputLevel.toFixed(4);
    appendDictationLog(
      `stt gen=${generation} secs=${seconds} decode_ms=${decodeMs} level=${level} whisper=${String(transcription.ranWhisper)} text=${JSON.stringify(dictated)}`,
    );
    if (dictated === "") {
      const detail = noSpeechDetail({ seconds, ranWhisper: transcription.ranWhisper });
      pipeline.status.write("inactive", detail);
      return;
    }

    const prompt = yield* refinedOrDictated({ pipeline, config, dictated, generation: job.generation });
    const delivered = yield* deliver({ pipeline, config, prompt });
    const totalMs = (performance.now() - started).toFixed(1);
    appendDictationLog(`delivered gen=${generation} total_ms=${totalMs} text=${JSON.stringify(delivered)}`);
    pipeline.status.write("inactive", "");
  }).pipe(
    Effect.catchAll((failure) =>
      Effect.sync(() => {
        appendDictationLog(`dictation failed gen=${String(job.generation)}: ${failure.message}`);
        pipeline.status.write("unavailable", failure.message);
      }),
    ),
  );

// `offer` enqueues a released clip, and `isIdle` tells live captions when they may run.
export const startDictationQueue = (pipeline: Pipeline) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<DictationJob>();
    let waiting = 0;
    let working = false;
    const isIdle = () => waiting === 0 && !working;
    const settle = Effect.gen(function* () {
      // Keep the last detail on screen briefly, and never hide the pill under a new hold.
      yield* Effect.sleep("800 millis");
      const stage = pipeline.status.stage();
      const showsDetail = Option.exists(stage, (current) => current !== "listening");
      if (isIdle() && showsDetail) {
        pipeline.status.write("inactive", "");
      }
    });
    const consume = Effect.gen(function* () {
      const job = yield* Queue.take(queue);
      waiting -= 1;
      working = true;
      yield* processJob(pipeline, job);
      working = false;
      if (isIdle()) {
        yield* Effect.fork(settle);
      }
    });
    yield* consume.pipe(Effect.forever, Effect.forkScoped);
    const offer = (job: DictationJob) =>
      Effect.gen(function* () {
        appendDictationLog(`enqueue gen=${String(job.generation)} samples=${String(job.samples.length)}`);
        waiting += 1;
        yield* Queue.offer(queue, job);
      });
    return { offer, isIdle };
  });

export type DictationQueue = Effect.Effect.Success<ReturnType<typeof startDictationQueue>>;
