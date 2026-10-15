/**
 * Speech text for Supertonic: short chunks so the first words play while the rest renders, and the
 * same text clean-up the Supertonic package does before it maps characters to model IDs.
 */

/** Short chunks so the first words are heard sooner. */
export const SPEECH_CHUNK_CHARACTERS = 280;

/** Split at the last sentence end that fits, else the last space, else hard at the limit. */
export const chunkSpeech = (text: string, maxCharacters: number): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  let remaining = text;
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters + 1);
    const sentenceEnds = [...window.matchAll(/[.!?](?:\s|$)/gu)].map((match) => match.index + match[0].length);
    const splitAt = sentenceEnds.at(-1) || window.lastIndexOf(" ") + 1;
    const cut = splitAt <= 0 || splitAt > maxCharacters ? maxCharacters : splitAt;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
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

/** The text Supertonic 3 reads, wrapped in its English language tags: `<en>Hello.</en>`. */
export const supertonicText = (text: string): string => {
  const cleaned = SYMBOL_REPLACEMENTS.reduce(replaceAll, text.normalize("NFKD").replace(EMOJI, ""))
    .replace(/[♥☆♡©\\]/gu, "")
    .replace(/ ([,.!?;:'])/gu, "$1")
    .replace(/(["'`])\1+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  const ended = /[.!?;:,'")\]}…。」』】〉》›»]$/u.test(cleaned) ? cleaned : `${cleaned}.`;
  return `<en>${ended}</en>`;
};

/** Model character IDs; characters the model has no ID for are dropped instead of failing the reply. */
export const characterIds = (text: string, indexer: ReadonlyArray<number>): ReadonlyArray<number> =>
  [...text].flatMap((character) => {
    const id = indexer[character.codePointAt(0) || 0];
    return id === undefined || id < 0 ? [] : [id];
  });

/** Words per minute → Supertonic speed (200 wpm is 1.0x), clamped to the model's 0.7–2.0x. */
export const speedForWordsPerMinute = (wordsPerMinute: number): number =>
  Math.min(Math.max(wordsPerMinute / 200, 0.7), 2);
