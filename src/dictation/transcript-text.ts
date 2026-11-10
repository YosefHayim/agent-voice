import { SAMPLE_RATE } from "./clip-audio.js";

const SPACE = " ";

// Strict for short clips, looser for long holds so real speech is never cut.
const MAX_WORDS_PER_SECOND_SHORT = 4;
const MAX_WORDS_PER_SECOND_LONG = 6;
const SHORT_CLIP_SECONDS = 3;
// Models answer a phrase this short with commentary instead of a rewrite.
const MIN_REFINE_WORDS = 5;

const SINGLE_WORD_NOISE = new Set([
  "music",
  "thanks",
  "thank",
  "subscribe",
  "copyright",
  "applause",
  "laughter",
  "silence",
  "blank",
  "mbn",
  "foreign",
  "inaudible",
]);

const splitWords = (string: string): ReadonlyArray<string> => string.split(/\s+/u).filter((word) => word !== "");

const readWordsPerSecond = (seconds: number): number => {
  const isShortClip = seconds < SHORT_CLIP_SECONDS;
  if (isShortClip) {
    return MAX_WORDS_PER_SECOND_SHORT;
  }

  return MAX_WORDS_PER_SECOND_LONG;
};

// Whisper invents prose on near-silence, so a clip keeps only the words its length could hold.
export const limitWordsToDuration = (string: string, sampleCount: number): string => {
  const words = splitWords(string);
  const minimumSpeechSeconds = 0.15;

  const seconds = Math.max(sampleCount / SAMPLE_RATE, minimumSpeechSeconds);
  const wordsPerSecond = readWordsPerSecond(seconds);

  const maxWords = Math.ceil(seconds * wordsPerSecond);

  const isWordsLengthAtMostMaxWords = words.length <= maxWords;
  if (isWordsLengthAtMostMaxWords) {
    return string;
  }

  return words.slice(0, maxWords).join(SPACE);
};

export const collapseRepeatedRuns = (string: string): string => {
  const words = splitWords(string);
  const kept = words.filter((word, index) => word.toLowerCase() !== words[index - 1]?.toLowerCase());
  return kept.join(SPACE);
};

export const rejectNoiseHallucination = (string: string, sampleCount: number): string => {
  const clean = string.trim();
  const seconds = sampleCount / SAMPLE_RATE;
  const lowercase = clean.toLowerCase();
  const lettersOnly = lowercase.replace(/[^\p{L}\p{N}\s]/gu, "");
  const words = splitWords(lettersOnly);
  const bareWords = words.join(SPACE);
  const singleWordNoiseSeconds = 2.5;

  const isNoiseWord = words.length === 1 && seconds < singleWordNoiseSeconds && SINGLE_WORD_NOISE.has(bareWords);

  const noisePhraseMaximumWords = 8;

  const noisePhraseSeconds = 4;

  const isNoisePhrase =
    seconds < noisePhraseSeconds &&
    words.length <= noisePhraseMaximumWords &&
    [
      "thank you for watching",
      "thanks for watching",
      "please subscribe",
      "like and subscribe",
      "see you next time",
      "thanks for listening",
      "subtitles by",
      "transcript by",
    ].some((phrase) => bareWords.includes(phrase));

  const isNoise = isNoiseWord || isNoisePhrase;
  if (isNoise) {
    return "";
  }

  return clean;
};

export const tidyWhisperTranscript = (string: string, sampleCount: number): string => {
  const trimmed = string.trim();
  const capped = limitWordsToDuration(trimmed, sampleCount);
  const collapsed = collapseRepeatedRuns(capped);
  return rejectNoiseHallucination(collapsed, sampleCount);
};

// An empty transcript is never typed.
export const cleanTranscript = (string: string): string => {
  const untagged = ["[MUSIC]", "[BLANK_AUDIO]", "[Silence]", "[silence]", "(music)", "(blank)", "♪"].reduce(
    (current, tag) => current.replaceAll(tag, ""),
    string,
  );
  const clean = splitWords(untagged).join(SPACE);
  const lowercase = clean.toLowerCase();

  const isNoSpeech = ["", "no speech", "no speech detected", ".", "..."].includes(lowercase);
  if (isNoSpeech) {
    return "";
  }

  return clean;
};

export const isShortPhrase = (transcript: string): boolean => splitWords(transcript).length < MIN_REFINE_WORDS;
