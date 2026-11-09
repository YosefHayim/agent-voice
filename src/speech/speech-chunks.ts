// Short chunks, so the first words play while the rest still renders.
export const SPEECH_CHUNK_CHARACTERS = 280;

const SENTENCE_END = /[.!?](?:\s|$)/gu;

// The last sentence end that fits, else the last space, else a hard cut at the limit.
const chunkEnd = (remaining: string, maxCharacters: number): number => {
  const window = remaining.slice(0, maxCharacters + 1);
  const sentenceEnds = [...window.matchAll(SENTENCE_END)].map((match) => match.index + match[0].length);
  const splitAt = sentenceEnds.at(-1) || window.lastIndexOf(" ") + 1;
  const fits = splitAt > 0 && splitAt <= maxCharacters;
  if (!fits) {
    return maxCharacters;
  }

  return splitAt;
};

export const chunkSpeech = (text: string, maxCharacters: number): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  let remaining = text;
  while (remaining.length > maxCharacters) {
    const end = chunkEnd(remaining, maxCharacters);
    const chunk = remaining.slice(0, end);
    chunks.push(chunk);
    remaining = remaining.slice(end);
  }
  chunks.push(remaining);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk !== "");
};

const EMOJI =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

const SYMBOL_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["–", "-"],
  ["‑", "-"],
  ["—", "-"],
  ["¯", " "],
  ["_", " "],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["´", "'"],
  ["`", "'"],
  ["[", " "],
  ["]", " "],
  ["|", " "],
  ["/", " "],
  ["#", " "],
  ["→", " "],
  ["←", " "],
  ["@", " at "],
  ["e.g.,", "for example, "],
  ["i.e.,", "that is, "],
];

const replaceAll = (text: string, [from, to]: readonly [string, string]) => text.split(from).join(to);

// The same clean-up the Supertonic package does before it maps characters to model IDs.
export const supertonicText = (text: string): string => {
  const withoutEmoji = text.normalize("NFKD").replace(EMOJI, "");
  const cleaned = SYMBOL_REPLACEMENTS.reduce(replaceAll, withoutEmoji)
    .replace(/[♥☆♡©\\]/gu, "")
    .replace(/ ([,.!?;:'])/gu, "$1")
    .replace(/(["'`])\1+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  const isEnded = /[.!?;:,'")\]}…。」』】〉》›»]$/u.test(cleaned);
  if (isEnded) {
    return `<en>${cleaned}</en>`;
  }

  return `<en>${cleaned}.</en>`;
};

// A character the model has no ID for is dropped instead of failing the reply.
export const characterIds = (text: string, indexer: ReadonlyArray<number>): ReadonlyArray<number> =>
  [...text].flatMap((character) => {
    const codePoint = character.codePointAt(0) || 0;
    const id = indexer[codePoint];
    if (id === undefined || id < 0) {
      return [];
    }

    return [id];
  });

// 200 wpm is Supertonic's 1.0x, and the model only takes 0.7x to 2.0x.
export const speedForWordsPerMinute = (wordsPerMinute: number): number => {
  const speed = wordsPerMinute / 200;
  const notTooSlow = Math.max(speed, 0.7);
  return Math.min(notTooSlow, 2);
};
