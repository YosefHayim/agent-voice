import { SAMPLE_RATE } from "./clipAudio.js";

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

const NOISE_PHRASES = [
  "thank you for watching",
  "thanks for watching",
  "please subscribe",
  "like and subscribe",
  "see you next time",
  "thanks for listening",
  "subtitles by",
  "transcript by",
];

const NO_SPEECH_TAGS = ["[MUSIC]", "[BLANK_AUDIO]", "[Silence]", "[silence]", "(music)", "(blank)", "♪"];
const NO_SPEECH_TEXTS = ["", "no speech", "no speech detected", ".", "..."];

const splitWords = (text: string): ReadonlyArray<string> => text.split(/\s+/u).filter((word) => word !== "");

const wordsPerSecondFor = (seconds: number): number => {
  if (seconds < SHORT_CLIP_SECONDS) {
    return MAX_WORDS_PER_SECOND_SHORT;
  }

  return MAX_WORDS_PER_SECOND_LONG;
};

// Whisper invents prose on near-silence, so a clip keeps only the words its length could hold.
export const capWordsForDuration = (text: string, sampleCount: number): string => {
  const words = splitWords(text);
  const seconds = Math.max(sampleCount / SAMPLE_RATE, 0.15);
  const wordsPerSecond = wordsPerSecondFor(seconds);
  const maxWords = Math.ceil(seconds * wordsPerSecond);
  if (words.length <= maxWords) {
    return text;
  }

  return words.slice(0, maxWords).join(" ");
};

export const collapseRepeatedRuns = (text: string): string => {
  const words = splitWords(text);
  const kept = words.filter((word, index) => word.toLowerCase() !== words[index - 1]?.toLowerCase());
  return kept.join(" ");
};

export const rejectNoiseHallucination = (text: string, sampleCount: number): string => {
  const clean = text.trim();
  const seconds = sampleCount / SAMPLE_RATE;
  const lowercase = clean.toLowerCase();
  const lettersOnly = lowercase.replace(/[^\p{L}\p{N}\s]/gu, "");
  const words = splitWords(lettersOnly);
  const bareText = words.join(" ");
  const isNoiseWord = words.length === 1 && seconds < 2.5 && SINGLE_WORD_NOISE.has(bareText);
  const isNoisePhrase = seconds < 4 && words.length <= 8 && NOISE_PHRASES.some((phrase) => bareText.includes(phrase));
  if (isNoiseWord || isNoisePhrase) {
    return "";
  }

  return clean;
};

export const tidyWhisperText = (text: string, sampleCount: number): string => {
  const trimmed = text.trim();
  const capped = capWordsForDuration(trimmed, sampleCount);
  const collapsed = collapseRepeatedRuns(capped);
  return rejectNoiseHallucination(collapsed, sampleCount);
};

// An empty transcript is never typed.
export const cleanTranscript = (text: string): string => {
  const untagged = NO_SPEECH_TAGS.reduce((current, tag) => current.replaceAll(tag, ""), text);
  const clean = splitWords(untagged).join(" ");
  const lowercase = clean.toLowerCase();
  const isNoSpeech = NO_SPEECH_TEXTS.includes(lowercase);
  if (isNoSpeech) {
    return "";
  }

  return clean;
};

export const isShortPhrase = (transcript: string): boolean => splitWords(transcript).length < MIN_REFINE_WORDS;
