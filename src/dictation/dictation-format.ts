type FormatCommand =
  | { readonly kind: "punctuation"; readonly mark: string }
  | { readonly kind: "newLine" }
  | { readonly kind: "newParagraph" }
  | { readonly kind: "bullet" }
  | { readonly kind: "numberedList" }
  | { readonly kind: "nextItem" };

type Piece = FormatCommand | { readonly kind: "words"; readonly text: string };

type SpokenCommand = { readonly phrase: ReadonlyArray<string>; readonly command: FormatCommand };

type Phrase = { readonly words: ReadonlyArray<string>; readonly written: string };

type Spoken = {
  readonly words: ReadonlyArray<string>;
  readonly canonical: ReadonlyArray<string>;
  readonly phrases: ReadonlyArray<Phrase>;
};

type FormatStatus = {
  readonly text: string;
  readonly atLineStart: boolean;
  readonly capitalizeNext: boolean;
  readonly needsSpace: boolean;
  readonly nextNumber: number;
};

const readPunctuation = (mark: string): FormatCommand => ({ kind: "punctuation", mark });

// Longer phrases come first, so "new bullet point" wins over "new bullet" and "bullet".
const SPOKEN_COMMANDS: ReadonlyArray<SpokenCommand> = [
  { phrase: ["exclamation", "mark"], command: readPunctuation("!") },
  { phrase: ["exclamation", "point"], command: readPunctuation("!") },
  { phrase: ["next", "bullet", "point"], command: { kind: "bullet" } },
  { phrase: ["new", "bullet", "point"], command: { kind: "bullet" } },
  { phrase: ["numbered", "list"], command: { kind: "numberedList" } },
  { phrase: ["new", "paragraph"], command: { kind: "newParagraph" } },
  { phrase: ["question", "mark"], command: readPunctuation("?") },
  { phrase: ["bullet", "list"], command: { kind: "bullet" } },
  { phrase: ["bullet", "point"], command: { kind: "bullet" } },
  { phrase: ["next", "bullet"], command: { kind: "bullet" } },
  { phrase: ["new", "bullet"], command: { kind: "bullet" } },
  { phrase: ["next", "item"], command: { kind: "nextItem" } },
  { phrase: ["next", "line"], command: { kind: "newLine" } },
  { phrase: ["full", "stop"], command: readPunctuation(".") },
  { phrase: ["new", "line"], command: { kind: "newLine" } },
  { phrase: ["semicolon"], command: readPunctuation(";") },
  { phrase: ["newline"], command: { kind: "newLine" } },
  { phrase: ["period"], command: readPunctuation(".") },
  { phrase: ["comma"], command: readPunctuation(",") },
  { phrase: ["colon"], command: readPunctuation(":") },
  { phrase: ["bullet"], command: { kind: "bullet" } },
  { phrase: ["dot"], command: readPunctuation(".") },
];

const SENTENCE_ENDS = [".", "!", "?"];

const initialFormat: FormatStatus = {
  text: "",
  atLineStart: true,
  capitalizeNext: true,
  needsSpace: false,
  nextNumber: 0,
};

const listReplacementPair = (line: string): ReadonlyArray<readonly [string, string]> => {
  const separator = line.indexOf("=");

  const isSeparatorNotFound = separator < 0;
  if (isSeparatorNotFound) {
    return [];
  }

  const heard = line.slice(0, separator).trim();

  const written = line.slice(separator + 1).trim();

  const hasEmptySide = heard === "" || written === "";
  if (hasEmptySide) {
    return [];
  }

  return [[heard, written]];
};

// A blank or one-sided pair is skipped, and a later pair for the same heard words wins.
export const parseReplacements = (replacementWords: string): ReadonlyMap<string, string> => {
  const pairs = replacementWords.split(";").flatMap(listReplacementPair);
  return new Map(pairs);
};

// Whisper's initial prompt holds both sides of every replacement, so names are spelled right.
export const readPromptBoost = (replacements: ReadonlyMap<string, string>): string => {
  const terms = [...replacements].flat();
  const uniqueTerms = new Set(terms);
  return [...uniqueTerms].sort().join(", ");
};

const readCanonicalWord = (word: string): string => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();

const listCanonicalWords = (string: string): ReadonlyArray<string> =>
  string
    .split(/\s+/u)
    .map(readCanonicalWord)
    .filter((word) => word !== "");

const readTrailingPunctuation = (word: string): string => /[^\p{L}\p{N}]+$/u.exec(word)?.[0] || "";

// Longest first, so the longest matching replacement wins.
const listReplacementPhrases = (replacements: ReadonlyMap<string, string>): ReadonlyArray<Phrase> =>
  [...replacements]
    .map(([heard, written]) => ({ words: listCanonicalWords(heard), written: written.trim() }))
    .filter((phrase) => phrase.words.length > 0 && phrase.written !== "")
    .sort((left, right) => right.words.length - left.words.length);

const hasPhraseAt = (request: {
  readonly words: ReadonlyArray<string>;
  readonly index: number;
  readonly phrase: ReadonlyArray<string>;
}): boolean =>
  request.words.length >= request.index + request.phrase.length &&
  request.phrase.every((word, offset) => request.words[request.index + offset] === word);

const readCommandAt = (spoken: Spoken, index: number): SpokenCommand | undefined =>
  SPOKEN_COMMANDS.find((spokenCommand) =>
    hasPhraseAt({ words: spoken.canonical, index, phrase: spokenCommand.phrase }),
  );

const readReplacementAt = (spoken: Spoken, index: number): Phrase | undefined =>
  spoken.phrases.find((phrase) => hasPhraseAt({ words: spoken.canonical, index, phrase: phrase.words }));

// "literal" types the next command or replacement phrase, or one word, as plain words.
const readLiteralLength = (spoken: Spoken, index: number): number => {
  const command = readCommandAt(spoken, index);

  const hasCommand = command !== undefined;
  if (hasCommand) {
    return command.phrase.length;
  }

  const replacement = readReplacementAt(spoken, index);

  const hasReplacement = replacement !== undefined;
  if (hasReplacement) {
    return replacement.words.length;
  }

  return 1;
};

const readPieceAt = (spoken: Spoken, index: number): { readonly piece: Piece; readonly length: number } => {
  const isLiteral = spoken.canonical[index] === "literal" && index + 1 < spoken.words.length;
  if (isLiteral) {
    const length = readLiteralLength(spoken, index + 1);
    const literal = spoken.words.slice(index + 1, index + 1 + length).join(" ");
    return { piece: { kind: "words", text: literal }, length: 1 + length };
  }

  const command = readCommandAt(spoken, index);

  const hasCommand = command !== undefined;
  if (hasCommand) {
    return { piece: command.command, length: command.phrase.length };
  }

  const replacement = readReplacementAt(spoken, index);

  const hasReplacement = replacement !== undefined;
  if (hasReplacement) {
    // The heard words' closing punctuation stays: "my name is Joseph." types "My name is Yosef."
    const lastHeard = spoken.words[index + replacement.words.length - 1];
    const closing = readTrailingPunctuation(lastHeard);
    return { piece: { kind: "words", text: `${replacement.written}${closing}` }, length: replacement.words.length };
  }

  return { piece: { kind: "words", text: spoken.words[index] }, length: 1 };
};

const listPiecesFrom = (spoken: Spoken, index: number): ReadonlyArray<Piece> => {
  const isPastLastWord = index >= spoken.words.length;
  if (isPastLastWord) {
    return [];
  }

  const { piece, length } = readPieceAt(spoken, index);
  return [piece, ...listPiecesFrom(spoken, index + length)];
};

const capitalizeFirstLetter = (string: string): string => string.replace(/[A-Za-z]/u, (letter) => letter.toUpperCase());

const readRenderedWords = (formatStatus: FormatStatus, words: string): string => {
  const isNotCapitalizeNext = !formatStatus.capitalizeNext;
  if (isNotCapitalizeNext) {
    return words;
  }

  return capitalizeFirstLetter(words);
};

const appendWords = (formatStatus: FormatStatus, words: string): string => {
  const isNotNeedsSpace = !formatStatus.needsSpace;
  if (isNotNeedsSpace) {
    return `${formatStatus.text}${words}`;
  }

  return `${formatStatus.text} ${words}`;
};

const pushWords = (formatStatus: FormatStatus, words: string): FormatStatus => {
  const rendered = readRenderedWords(formatStatus, words);
  const string = appendWords(formatStatus, rendered);
  // A sentence end, ignoring closing quotes, capitalizes the next word.
  const endsSentence = /[.!?]["']*$/u.test(rendered);
  return { ...formatStatus, text: string, atLineStart: false, capitalizeNext: endsSentence, needsSpace: true };
};

const readBreakLine = (formatStatus: FormatStatus, lineBreak: string): FormatStatus => ({
  ...formatStatus,
  text: `${formatStatus.text}${lineBreak}`,
  atLineStart: true,
  capitalizeNext: true,
  needsSpace: false,
});

const readFreshLineDictation = (formatStatus: FormatStatus): string => {
  if (formatStatus.atLineStart) {
    return formatStatus.text;
  }

  return `${formatStatus.text}\n`;
};

const startListLine = (formatStatus: FormatStatus, marker: string): FormatStatus => {
  const string = readFreshLineDictation(formatStatus);
  return { ...formatStatus, text: `${string}${marker}`, atLineStart: false, capitalizeNext: true, needsSpace: false };
};

const listNumber = (formatStatus: FormatStatus, kind: "numberedList" | "nextItem"): number => {
  const isNewList = kind === "numberedList" || formatStatus.nextNumber < 1;
  if (isNewList) {
    return 1;
  }

  return formatStatus.nextNumber;
};

const pushPiece = (formatStatus: FormatStatus, piece: Piece): FormatStatus => {
  switch (piece.kind) {
    case "words":
      return pushWords(formatStatus, piece.text);
    case "punctuation": {
      const endsSentence = SENTENCE_ENDS.includes(piece.mark);
      const string = `${formatStatus.text}${piece.mark}`;
      return { ...formatStatus, text: string, atLineStart: false, capitalizeNext: endsSentence, needsSpace: true };
    }
    case "newLine":
      return readBreakLine(formatStatus, "\n");
    case "newParagraph":
      return readBreakLine(formatStatus, "\n\n");
    case "bullet": {
      const element = startListLine(formatStatus, "- ");
      return { ...element, nextNumber: 0 };
    }
    case "numberedList":
    case "nextItem": {
      const number = listNumber(formatStatus, piece.kind);
      const listLine = startListLine(formatStatus, `${String(number)}. `);
      return { ...listLine, nextNumber: number + 1 };
    }
  }
};

// Ends with a space when the next utterance should start a new word, and is empty when nothing should be typed.
const readFinishedDictation = (formatStatus: FormatStatus): string => {
  const endsWithWord = formatStatus.text !== "" && formatStatus.needsSpace;

  const isNotEndingWithWord = !endsWithWord;
  if (isNotEndingWithWord) {
    return formatStatus.text;
  }

  return `${formatStatus.text} `;
};

export const createDictationTranscript = (transcript: string, replacements: ReadonlyMap<string, string>): string => {
  const words = transcript.split(/\s+/u).filter((word) => word !== "");
  const canonical = words.map(readCanonicalWord);
  const phrases = listReplacementPhrases(replacements);
  const pieces = listPiecesFrom({ words, canonical, phrases }, 0);
  const formatStatus = pieces.reduce(pushPiece, initialFormat);
  return readFinishedDictation(formatStatus);
};
