/**
 * The live caption while Shift is held: a Whisper pass over the last 8 s every 700 ms, shown in the pill
 * only. The final text always comes from the queue; the best caption is its fallback for short clips.
 */

import { Effect } from "effect";

import { readConfigOrDefaults } from "../settings/configFile.js";
import { appendDictationLog } from "../workers/workerLog.js";
import type { StatusWriter } from "../workers/workerStatus.js";
import type { ClipBuffer } from "./microphone.js";
import { cleanTranscript, SAMPLE_RATE } from "./speechDetection.js";
import type { Transcriber } from "./transcriber.js";

/** Short enough that words appear while the key is still held. */
const CAPTION_INTERVAL = "700 millis";
/** Wide, so the fallback is not just the last few words of a long hold. */
const CAPTION_TAIL_SECONDS = 8;
/** About 0.4 s of audio before the first caption. */
const MIN_CAPTION_SAMPLES = SAMPLE_RATE * 0.4;

/** The best caption of the current hold; a shorter later tail never replaces a better mid-hold decode. */
export const makeLiveCaption = () => {
  let best = "";
  return {
    offer: (text: string) => {
      if (text.length >= best.length) {
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

const captionOnce = (request: {
  readonly clip: ClipBuffer;
  readonly transcriber: Transcriber;
  readonly caption: LiveCaption;
  readonly status: StatusWriter;
}) =>
  Effect.gen(function* () {
    if (request.clip.sampleCount() < MIN_CAPTION_SAMPLES) {
      return;
    }

    const config = yield* readConfigOrDefaults;
    const clipNumber = request.clip.clipNumber();
    const heard = yield* request.transcriber.caption({
      samples: request.clip.tail(CAPTION_TAIL_SECONDS),
      language: config.dictationLanguage,
    });
    const text = cleanTranscript(heard._tag === "Some" ? heard.value : "");
    // A pass that finishes after its hold ended and a new one began holds the old hold's words: drop it.
    if (text !== "" && request.clip.isRecording() && request.clip.clipNumber() === clipNumber) {
      request.caption.offer(text);
      request.status.writePreview(text);
    }
  }).pipe(Effect.catchAll((error) => Effect.sync(() => appendDictationLog(`live caption: ${error.message}`))));

/** Runs for the worker's lifetime; it only works while a hold is recording. */
export const captionLoop = (request: {
  readonly clip: ClipBuffer;
  readonly transcriber: Transcriber;
  readonly caption: LiveCaption;
  readonly status: StatusWriter;
}): Effect.Effect<never> =>
  Effect.forever(
    Effect.suspend(() =>
      request.clip.isRecording()
        ? Effect.zipRight(captionOnce(request), Effect.sleep(CAPTION_INTERVAL))
        : Effect.sleep("50 millis"),
    ),
  );
