// The live caption while the hold key is held: a Whisper pass over the last 8 s every 700 ms, shown in the pill only.
// The final text always comes from the queue; the best caption is its fallback for short clips.

import { readConfigOrDefaults } from "#src/settings/config-file.js";
import { sleep } from "#src/sleep.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import type { StatusWriter } from "#src/workers/worker-status.js";
import { SAMPLE_RATE } from "./clip-audio.js";
import type { ClipBuffer } from "./microphone.js";
import type { Transcriber } from "./transcriber.js";
import { cleanTranscript } from "./transcript-text.js";

// Short enough that words appear while the key is still held.
const captionIntervalMilliseconds = 700;
// Wide, so the fallback is not just the last few words of a long hold.
const CAPTION_TAIL_SECONDS = 8;
const MIN_CAPTION_SAMPLES = SAMPLE_RATE * 0.4;

// A shorter later tail never replaces a better mid-hold caption.
export const makeLiveCaption = () => {
  let best = "";
  return {
    offer: (text: string) => {
      const isLengthAtLeastBestLength = text.length >= best.length;
      if (isLengthAtLeastBestLength) {
        best = text;
      }
    },
    take: (): string => {
      const taken = best;
      best = "";
      return taken;
    },
    clear: () => {
      best = "";
    },
  };
};

export type LiveCaption = ReturnType<typeof makeLiveCaption>;

type CaptionRequest = {
  readonly clip: ClipBuffer;
  readonly transcriber: Transcriber;
  readonly caption: LiveCaption;
  readonly status: StatusWriter;
  // Aborted when the dictation worker stops, which ends the caption loop.
  readonly shutdown: AbortSignal;
};

const captionOnce = async (request: CaptionRequest): Promise<void> => {
  const isClipTooShort = request.clip.sampleCount() < MIN_CAPTION_SAMPLES;
  if (isClipTooShort) {
    return;
  }

  try {
    const config = readConfigOrDefaults();
    const clipNumber = request.clip.clipNumber();
    const samples = request.clip.tail(CAPTION_TAIL_SECONDS);
    const heard = await request.transcriber.caption({ samples, language: config.dictationLanguage });
    const text = cleanTranscript(heard ?? "");
    // A pass that finishes after its hold ended and a new one began holds the old hold's words: drop it.
    const isSameHold = request.clip.isRecording() && request.clip.clipNumber() === clipNumber;

    const isCaptionEmpty = text === "";

    const isCaptionUnusable = isCaptionEmpty || !isSameHold;
    if (isCaptionUnusable) {
      return;
    }

    request.caption.offer(text);
    request.status.writePreview(text);
  } catch (error) {
    appendDictationLog(`live caption: ${String(error)}`);
  }
};

const captionStep = async (request: CaptionRequest): Promise<void> => {
  const isNotRecording = !request.clip.isRecording();
  if (isNotRecording) {
    await sleep(50);
    return;
  }

  await captionOnce(request);
  await sleep(captionIntervalMilliseconds);
};

const isCaptionLoopStopped = (request: CaptionRequest): boolean => request.shutdown.aborted;

// Runs for the worker's lifetime; it only works while a hold is recording.
export const captionLoop = async (request: CaptionRequest): Promise<void> => {
  while (!isCaptionLoopStopped(request)) {
    await captionStep(request);
  }
};
