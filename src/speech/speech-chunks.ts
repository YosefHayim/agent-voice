const FIRST_GROUP_REFERENCE = "$1";

const SINGLE_QUOTE = "'";

const DOUBLE_QUOTE = '"';

const DASH_CHARACTER = "-";

const SPACE = " ";

// Short chunks, so the first words play while the rest still renders.
export const SPEECH_CHUNK_CHARACTERS = 280;

// The last sentence end that fits, else the last space, else a hard cut at the limit.
const chunkEnd = (remaining: string, maxCharacters: number): number => {
  const window = remaining.slice(0, maxCharacters + 1);
  const sentenceEnds = [...window.matchAll(/[.!?](?:\s|$)/gu)].map(
    (sentenceEnd) => sentenceEnd.index + sentenceEnd[0].length,
  );
  const splitAt = sentenceEnds.at(-1) || window.lastIndexOf(SPACE) + 1;

  const fits = splitAt > 0 && splitAt <= maxCharacters;

  const isNotFitting = !fits;
  if (isNotFitting) {
    return maxCharacters;
  }

  return splitAt;
};

export const chunkSpeech = (string: string, maxCharacters: number): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  let remaining = string;
  while (remaining.length > maxCharacters) {
    const end = chunkEnd(remaining, maxCharacters);
    const chunk = remaining.slice(0, end);
    chunks.push(chunk);
    remaining = remaining.slice(end);
  }
  chunks.push(remaining);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk !== "");
};

const replaceAll = (string: string, [from, to]: readonly [string, string]) => string.split(from).join(to);

// The same clean-up the Supertonic package does before it maps characters to model IDs.
export const readSupertonicSpeech = (string: string): string => {
  const withoutEmoji = string
    .normalize("NFKD")
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu,
      "",
    );
  const cleaned = [
    ["–", DASH_CHARACTER],
    ["‑", DASH_CHARACTER],
    ["—", DASH_CHARACTER],
    ["¯", SPACE],
    ["_", SPACE],
    ["“", DOUBLE_QUOTE],
    ["”", DOUBLE_QUOTE],
    ["‘", SINGLE_QUOTE],
    ["’", SINGLE_QUOTE],
    ["´", SINGLE_QUOTE],
    ["`", SINGLE_QUOTE],
    ["[", SPACE],
    ["]", SPACE],
    ["|", SPACE],
    ["/", SPACE],
    ["#", SPACE],
    ["→", SPACE],
    ["←", SPACE],
    ["@", " at "],
    ["e.g.,", "for example, "],
    ["i.e.,", "that is, "],
  ]
    .reduce(replaceAll, withoutEmoji)
    .replace(/[♥☆♡©\\]/gu, "")
    .replace(/ ([,.!?;:'])/gu, FIRST_GROUP_REFERENCE)
    .replace(/(["'`])\1+/gu, FIRST_GROUP_REFERENCE)
    .replace(/\s+/gu, SPACE)
    .trim();

  const isEnded = /[.!?;:,'")\]}…。」』】〉》›»]$/u.test(cleaned);
  if (isEnded) {
    return `<en>${cleaned}</en>`;
  }

  return `<en>${cleaned}.</en>`;
};

// A character the model has no ID for is dropped instead of failing the reply.
export const listCharacterIds = (string: string, indexer: ReadonlyArray<number>): ReadonlyArray<number> =>
  [...string].flatMap((character) => {
    const codePoint = character.codePointAt(0) || 0;

    const id = indexer[codePoint];

    const isNoValidId = id == null || id < 0;
    if (isNoValidId) {
      return [];
    }

    return [id];
  });

// 200 wpm is Supertonic's 1.0x, and the model only takes 0.7x to 2.0x.
export const readSpeedFromWordsPerMinute = (wordsPerMinute: number): number => {
  const typicalWordsPerMinute = 200;

  const speed = wordsPerMinute / typicalWordsPerMinute;
  const minimumSpeedFactor = 0.7;

  const notTooSlow = Math.max(speed, minimumSpeedFactor);
  const maximumSpeedFactor = 2;

  return Math.min(notTooSlow, maximumSpeedFactor);
};
