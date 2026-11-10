import { describeError } from "#src/error-message.js";
import { deliverToCmux } from "#src/refine/cmux-delivery.js";
import { refinePrompt } from "#src/refine/refine-attempts.js";
import { readSettingsOrDefaults } from "#src/settings/config-file.js";
import type { Settings } from "#src/settings/config-schema.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import type { StatusWriter } from "#src/workers/worker-status.js";
import { typeAtCaret } from "./caret.js";
import { SAMPLE_RATE } from "./clip-audio.js";
import { createDictationTranscript, parseReplacements, readPromptBoost } from "./dictation-format.js";
import type { Keyboard } from "./keyboard.js";
import type { Transcriber } from "./transcriber.js";
import { cleanTranscript, isShortPhrase } from "./transcript-text.js";

const INACTIVE_STAGE = "inactive";

interface DictationJob {
  readonly samples: Float32Array;
  // Typed when the final decode hears nothing, which happens on short clips.
  readonly fallbackCaption: string;
  readonly generation: number;
}

// A release only enqueues its clip, and jobs run one after another, so the next hold can start while the previous
// clip decodes. Text is typed once and never erased and retyped, because the caret may have moved by the time a
// model answers.
export interface DictationPipeline {
  readonly transcriber: Transcriber;
  readonly keyboard: Keyboard;
  readonly status: StatusWriter;
  // Aborted when the worker stops, so refine CLIs still running are killed.
  readonly shutdown: AbortSignal;
}

interface Prompt {
  readonly promptText: string;
  readonly isRefined: boolean;
}

// Typing waits this long for a refined prompt, then types what was dictated.
const refineWaitMilliseconds = 20_000;
// Keeps the last detail on screen briefly before the pill clears.
const idleDetailHoldMilliseconds = 800;

const isDictationRefine = (settings: Settings): boolean =>
  settings.refineMode === "dictation" || settings.refineMode === "both";

const describeRefineLabel = (settings: Settings): string => {
  const model = settings.refineModel || "default model";

  const isRefineEffortMissing = settings.refineEffort == null;
  if (isRefineEffortMissing) {
    return `${settings.refineProvider}/${model}`;
  }

  return `${settings.refineProvider}/${model}/${settings.refineEffort}`;
};

// Null when the wait ends first; the refine keeps running in the background, so a picker choice is still saved.
const waitForRefine = (refining: Promise<string>): Promise<string | null> => {
  const waitElapsed = new Promise<null>((finish) => {
    setTimeout(() => finish(null), refineWaitMilliseconds);
  });
  return Promise.race([refining, waitElapsed]);
};

const keepDictation = (request: {
  readonly dictatedText: string;
  readonly generation: string;
  readonly elapsed: string;
  readonly why: string;
}): Prompt => {
  appendDictationLog(`refine kept dictation gen=${request.generation} after ${request.elapsed} ms: ${request.why}`);
  return { promptText: request.dictatedText, isRefined: false };
};

const readRefinedOrDictated = async (request: {
  readonly pipeline: DictationPipeline;
  readonly config: Settings;
  readonly dictated: string;
  readonly generation: number;
}): Promise<Prompt> => {
  const generation = String(request.generation);
  const dictatedPrompt: Prompt = { promptText: request.dictated, isRefined: false };

  const isRefineOff = !isDictationRefine(request.config);
  if (isRefineOff) {
    return dictatedPrompt;
  }

  const isPhraseTooShort = isShortPhrase(request.dictated);
  if (isPhraseTooShort) {
    appendDictationLog(`refine skipped gen=${generation}: short phrase`);
    return dictatedPrompt;
  }

  const label = describeRefineLabel(request.config);
  request.pipeline.status.write("refining", `Refining (${label})…`);
  const started = performance.now();
  const refining = refinePrompt({
    draft: request.dictated,
    provider: request.config.refineProvider,
    model: request.config.refineModel || "",
    effort: request.config.refineEffort || "",
    allowPicker: true,
    signal: request.pipeline.shutdown,
    log: appendDictationLog,
  });
  try {
    const refinedTranscript = await waitForRefine(refining);
    const elapsed = (performance.now() - started).toFixed(0);

    const isWaitElapsed = refinedTranscript == null;
    if (isWaitElapsed) {
      return keepDictation({
        dictatedText: request.dictated,
        generation,
        elapsed,
        why: "still refining after 20 seconds",
      });
    }

    const isReplyEmpty = refinedTranscript.trim() === "";
    if (isReplyEmpty) {
      return keepDictation({ dictatedText: request.dictated, generation, elapsed, why: "empty reply" });
    }

    appendDictationLog(`refine gen=${generation} refine_ms=${elapsed} refined=${JSON.stringify(refinedTranscript)}`);
    return { promptText: refinedTranscript, isRefined: true };
  } catch (error) {
    const elapsed = (performance.now() - started).toFixed(0);
    const failureReason = describeError(error);
    return keepDictation({ dictatedText: request.dictated, generation, elapsed, why: failureReason });
  }
};

const typeDictation = async (request: {
  readonly pipeline: DictationPipeline;
  readonly config: Settings;
  readonly text: string;
}): Promise<string> => {
  const replacements = parseReplacements(request.config.dictationReplacements);
  const formatted = createDictationTranscript(request.text, replacements);
  await typeAtCaret({
    keyboard: request.pipeline.keyboard,
    text: formatted,
    pressEnter: request.config.refinePressEnter,
  });

  const isNotRefinePressEnter = !request.config.refinePressEnter;
  if (isNotRefinePressEnter) {
    return formatted;
  }

  return `${formatted} [Enter]`;
};

// Dictated text, and a refined prompt whose cmux delivery failed, are typed at the caret.
const deliverPrompt = async (request: {
  readonly pipeline: DictationPipeline;
  readonly config: Settings;
  readonly prompt: Prompt;
}): Promise<string> => {
  const isNotGoingToCmux = !request.prompt.isRefined || request.config.refineSendTo === "caret";
  if (isNotGoingToCmux) {
    return typeDictation({ pipeline: request.pipeline, config: request.config, text: request.prompt.promptText });
  }

  try {
    const deliveryMessage = await deliverToCmux({ promptText: request.prompt.promptText, config: request.config });
    return deliveryMessage;
  } catch (error) {
    appendDictationLog(`cmux delivery failed: ${describeError(error)}; typing at the caret`);
    return typeDictation({ pipeline: request.pipeline, config: request.config, text: request.prompt.promptText });
  }
};

const describeNoSpeech = (request: { readonly seconds: string; readonly ranWhisper: boolean }): string => {
  if (request.ranWhisper) {
    return `No speech (${request.seconds}s audio)`;
  }

  return `No speech (${request.seconds}s, silence)`;
};

const decodeAndDeliverJob = async (pipeline: DictationPipeline, job: DictationJob): Promise<void> => {
  const generation = String(job.generation);
  const secondsDecimalPlaces = 2;

  const seconds = (job.samples.length / SAMPLE_RATE).toFixed(secondsDecimalPlaces);
  pipeline.status.write("finishing", `Decoding ${String(job.samples.length)} samples…`);
  const settings = readSettingsOrDefaults();
  const started = performance.now();
  const replacements = parseReplacements(settings.dictationReplacements);
  const transcriptionPrompt = readPromptBoost(replacements);
  const transcription = await pipeline.transcriber.transcribe({
    samples: job.samples,
    language: settings.dictationLanguage,
    prompt: transcriptionPrompt,
  });
  const dictated = cleanTranscript(transcription.text) || cleanTranscript(job.fallbackCaption);
  const decodeMs = transcription.decodeMs.toFixed(1);
  const levelDecimalPlaces = 4;

  const level = transcription.inputLevel.toFixed(levelDecimalPlaces);
  appendDictationLog(
    `stt gen=${generation} secs=${seconds} decode_ms=${decodeMs} level=${level} whisper=${String(transcription.ranWhisper)} text=${JSON.stringify(dictated)}`,
  );

  const isNoSpeech = dictated === "";
  if (isNoSpeech) {
    const detail = describeNoSpeech({ seconds, ranWhisper: transcription.ranWhisper });
    pipeline.status.write(INACTIVE_STAGE, detail);
    return;
  }

  const prompt = await readRefinedOrDictated({ pipeline, config: settings, dictated, generation: job.generation });
  const delivered = await deliverPrompt({ pipeline, config: settings, prompt });
  const totalMs = (performance.now() - started).toFixed(1);
  appendDictationLog(`delivered gen=${generation} total_ms=${totalMs} text=${JSON.stringify(delivered)}`);
  pipeline.status.write(INACTIVE_STAGE, "");
};

const runDictationJob = async (pipeline: DictationPipeline, job: DictationJob): Promise<void> => {
  try {
    await decodeAndDeliverJob(pipeline, job);
  } catch (error) {
    const detail = describeError(error);
    appendDictationLog(`dictation failed gen=${String(job.generation)}: ${detail}`);
    pipeline.status.write("unavailable", detail);
  }
};

export interface DictationQueue {
  readonly offer: (job: DictationJob) => void;
  readonly isIdle: () => boolean;
}

export const startDictationQueue = (pipeline: DictationPipeline): DictationQueue => {
  let waitingCount = 0;
  let isWorking = false;
  // Each job waits for the job before it, so jobs never overlap.
  let lastJobDone: Promise<void> = Promise.resolve();
  const isIdle = (): boolean => waitingCount === 0 && !isWorking;

  // Keeps the last detail on screen briefly, and never hides the pill under a new hold.
  const clearIdleDetailLater = (): void => {
    setTimeout(() => {
      const stage = pipeline.status.stage();

      const showsDetail = stage != null && stage !== "listening";

      const isIdleShowingDetail = isIdle() && showsDetail;
      if (isIdleShowingDetail) {
        pipeline.status.write(INACTIVE_STAGE, "");
      }
    }, idleDetailHoldMilliseconds);
  };

  const runQueuedJob = async (previousJobDone: Promise<void>, job: DictationJob): Promise<void> => {
    await previousJobDone;
    waitingCount -= 1;
    isWorking = true;
    await runDictationJob(pipeline, job);
    isWorking = false;

    if (isIdle()) {
      clearIdleDetailLater();
    }
  };

  const offer = (job: DictationJob): void => {
    appendDictationLog(`enqueue gen=${String(job.generation)} samples=${String(job.samples.length)}`);
    waitingCount += 1;
    lastJobDone = runQueuedJob(lastJobDone, job);
  };

  return { offer, isIdle };
};
