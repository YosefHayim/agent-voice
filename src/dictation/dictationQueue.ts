/**
 * The serial dictation queue: a release only enqueues its clip, and one fiber decodes, refines, and
 * delivers clips in order, so the next hold can start while the previous one decodes. Text is typed once:
 * it is never erased and retyped, because the caret may have moved by the time a model answers.
 */

import { Effect, Fiber, Option, Queue } from "effect";
import { deliverToCmux } from "../refine/cmuxDelivery.js";
import { refinePrompt } from "../refine/refineAttempts.js";
import { readConfigOrDefaults } from "../settings/configFile.js";
import type { Config } from "../settings/configSchema.js";
import { appendDictationLog } from "../workers/workerLog.js";
import type { StatusWriter } from "../workers/workerStatus.js";
import { typeAtCaret } from "./caret.js";
import { formatDictation, parseReplacements, promptBoost } from "./dictationFormat.js";
import type { Keyboard } from "./keyboard.js";
import { cleanTranscript, isShortPhrase, SAMPLE_RATE } from "./speechDetection.js";
import type { Transcriber } from "./transcriber.js";

type DictationJob = {
  readonly samples: Float32Array;
  /** The best live caption, typed when the final decode hears nothing (short clips). */
  readonly fallbackCaption: string;
  readonly generation: number;
};

/** Typing waits this long for a refined prompt, then types what was dictated. */
const REFINE_WAIT = "20 seconds";

type Pipeline = { readonly transcriber: Transcriber; readonly keyboard: Keyboard; readonly status: StatusWriter };

const isDictationRefine = (config: Config) => config.refineMode === "dictation" || config.refineMode === "both";

/**
 * The refined prompt, or the dictated text when the phrase is short or the model fails or is slower than
 * REFINE_WAIT, and which of the two it is; a slow refine keeps running in the background so a picker choice
 * is still saved.
 */
const refinedOrDictated = (request: {
  readonly pipeline: Pipeline;
  readonly config: Config;
  readonly dictated: string;
  readonly generation: number;
}) =>
  Effect.gen(function* () {
    if (isShortPhrase(request.dictated)) {
      appendDictationLog(`refine skipped gen=${String(request.generation)}: short phrase`);
      return { text: request.dictated, refined: false };
    }

    const model = request.config.refineModel || "default model";
    const effort = request.config.refineEffort === undefined ? "" : `/${request.config.refineEffort}`;
    request.pipeline.status.write("refining", `Refining (${request.config.refineProvider}/${model}${effort})…`);
    const started = performance.now();
    const refine = yield* Effect.forkDaemon(
      refinePrompt({
        draft: request.dictated,
        provider: request.config.refineProvider,
        model: request.config.refineModel || "",
        effort: request.config.refineEffort || "",
        allowPicker: true,
        log: appendDictationLog,
      }),
    );
    const refined = yield* Effect.either(Effect.timeout(Fiber.join(refine), REFINE_WAIT));
    const elapsed = (performance.now() - started).toFixed(0);
    if (refined._tag === "Right" && refined.right.trim() !== "") {
      appendDictationLog(
        `refine gen=${String(request.generation)} refine_ms=${elapsed} refined=${JSON.stringify(refined.right)}`,
      );
      return { text: refined.right, refined: true };
    }

    const why = refined._tag === "Left" ? refined.left.message : "empty reply";
    appendDictationLog(`refine kept dictation gen=${String(request.generation)} after ${elapsed} ms: ${why}`);
    return { text: request.dictated, refined: false };
  });

const typeDictation = (request: { readonly pipeline: Pipeline; readonly config: Config; readonly text: string }) =>
  Effect.gen(function* () {
    const formatted = formatDictation(request.text, parseReplacements(request.config.dictationReplacements));
    yield* typeAtCaret({
      keyboard: request.pipeline.keyboard,
      text: formatted,
      pressEnter: request.config.refinePressEnter,
    });
    return request.config.refinePressEnter ? `${formatted} [Enter]` : formatted;
  });

// A refined prompt goes where refineSendTo says; dictated text (short, skipped, failed, or slow refine) is typed at
// the caret, and so is a refined prompt whose cmux delivery failed.
const deliver = (request: {
  readonly pipeline: Pipeline;
  readonly config: Config;
  readonly text: string;
  readonly refined: boolean;
}) =>
  request.refined && request.config.refineSendTo !== "caret"
    ? deliverToCmux({ text: request.text, config: request.config }).pipe(
        Effect.catchAll((failure) => {
          appendDictationLog(`cmux delivery failed: ${failure.message}; typing at the caret`);
          return typeDictation(request);
        }),
      )
    : typeDictation(request);

const processJob = (pipeline: Pipeline, job: DictationJob) =>
  Effect.gen(function* () {
    const seconds = (job.samples.length / SAMPLE_RATE).toFixed(2);
    pipeline.status.write("finishing", `Decoding ${String(job.samples.length)} samples…`);
    const config = yield* readConfigOrDefaults;
    const started = performance.now();
    const transcription = yield* pipeline.transcriber.transcribe({
      samples: job.samples,
      language: config.dictationLanguage,
      prompt: promptBoost(parseReplacements(config.dictationReplacements)),
    });
    const dictated = cleanTranscript(transcription.text) || cleanTranscript(job.fallbackCaption);
    appendDictationLog(
      `stt gen=${String(job.generation)} secs=${seconds} decode_ms=${transcription.decodeMs.toFixed(1)} level=${transcription.inputLevel.toFixed(4)} whisper=${String(transcription.ranWhisper)} text=${JSON.stringify(dictated)}`,
    );
    if (dictated === "") {
      pipeline.status.write(
        "inactive",
        transcription.ranWhisper ? `No speech (${seconds}s audio)` : `No speech (${seconds}s, silence)`,
      );
      return;
    }

    const prompt = isDictationRefine(config)
      ? yield* refinedOrDictated({ pipeline, config, dictated, generation: job.generation })
      : { text: dictated, refined: false };
    const delivered = yield* deliver({ pipeline, config, text: prompt.text, refined: prompt.refined });
    appendDictationLog(
      `delivered gen=${String(job.generation)} total_ms=${(performance.now() - started).toFixed(1)} text=${JSON.stringify(delivered)}`,
    );
    pipeline.status.write("inactive", "");
  }).pipe(
    Effect.catchAll((failure) =>
      Effect.sync(() => {
        appendDictationLog(`dictation failed gen=${String(job.generation)}: ${failure.message}`);
        pipeline.status.write("unavailable", failure.message);
      }),
    ),
  );

/** Start the queue's single consumer; `offer` enqueues a released clip and `isIdle` tells captions when to run. */
export const startDictationQueue = (pipeline: Pipeline) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<DictationJob>();
    let waiting = 0;
    let working = false;
    const isIdle = () => waiting === 0 && !working;
    const settle = Effect.gen(function* () {
      // Keep the last detail on screen briefly, and never hide the pill under a new hold.
      yield* Effect.sleep("800 millis");
      if (isIdle() && Option.exists(pipeline.status.stage(), (stage) => stage !== "listening")) {
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
    yield* Effect.forkScoped(Effect.forever(consume));
    const offer = (job: DictationJob) =>
      Effect.sync(() => {
        appendDictationLog(`enqueue gen=${String(job.generation)} samples=${String(job.samples.length)}`);
        waiting += 1;
      }).pipe(Effect.zipRight(Queue.offer(queue, job)));
    return { offer, isIdle };
  });

export type DictationQueue = Effect.Effect.Success<ReturnType<typeof startDictationQueue>>;
