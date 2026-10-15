// The live caption while Shift is held: a Whisper pass over the last 8 s every 700 ms, shown in the pill only.
// The final text always comes from the queue; the best caption is its fallback for short clips.

import { Effect, Option } from "effect";

import { readConfigOrDefaults } from "../settings/configFile.js";
import { appendDictationLog } from "../workers/workerLog.js";
import type { StatusWriter } from "../workers/workerStatus.js";
import { SAMPLE_RATE } from "./clipAudio.js";
import type { ClipBuffer } from "./microphone.js";
import type { Transcriber } from "./transcriber.js";
import { cleanTranscript } from "./transcriptText.js";

// Short enough that words appear while the key is still held.
const CAPTION_INTERVAL = "700 millis";
// Wide, so the fallback is not just the last few words of a long hold.
const CAPTION_TAIL_SECONDS = 8;
const MIN_CAPTION_SAMPLES = SAMPLE_RATE * 0.4;

// A shorter later tail never replaces a better mid-hold caption.
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

type CaptionRequest = {
  readonly clip: ClipBuffer;
  readonly transcriber: Transcriber;
  readonly caption: LiveCaption;
  readonly status: StatusWriter;
};

const captionOnce = (request: CaptionRequest) =>
  Effect.gen(function* () {
    if (request.clip.sampleCount() < MIN_CAPTION_SAMPLES) {
      return;
    }

    const config = yield* readConfigOrDefaults;
    const clipNumber = request.clip.clipNumber();
    const samples = request.clip.tail(CAPTION_TAIL_SECONDS);
    const heard = yield* request.transcriber.caption({ samples, language: config.dictationLanguage });
    const heardText = Option.getOrElse(heard, () => "");
    const text = cleanTranscript(heardText);
    // A pass that finishes after its hold ended and a new one began holds the old hold's words: drop it.
    const isSameHold = request.clip.isRecording() && request.clip.clipNumber() === clipNumber;
    if (text === "" || !isSameHold) {
      return;
    }

    request.caption.offer(text);
    request.status.writePreview(text);
  }).pipe(Effect.catchAll((error) => Effect.sync(() => appendDictationLog(`live caption: ${error.message}`))));

const captionStep = (request: CaptionRequest) =>
  Effect.gen(function* () {
    if (!request.clip.isRecording()) {
      yield* Effect.sleep("50 millis");
      return;
    }

    yield* captionOnce(request);
    yield* Effect.sleep(CAPTION_INTERVAL);
  });

// Runs for the worker's lifetime; it only works while a hold is recording.
export const captionLoop = (request: CaptionRequest): Effect.Effect<never> => captionStep(request).pipe(Effect.forever);
