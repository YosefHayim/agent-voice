const WORDS_PIECE_KIND = "words";

const SEMICOLON_MARK = ";";

const PERIOD_MARK = ".";

const NEW_LINE_KIND = "newLine";

const LINE_WORD = "line";

const NEXT_LIST_MARK_KIND = "nextItem";

const QUESTION_MARK = "?";

const NEW_PARAGRAPH_KIND = "newParagraph";

const NUMBERED_LIST_KIND = "numberedList";

const LIST_WORD = "list";

const NEW_WORD = "new";

const BULLET_WORD = "bullet";

const NEXT_WORD = "next";

const POINT_WORD = "point";

const EXCLAMATION_MARK = "!";

const MARK_WORD = "mark";

const EXCLAMATION_WORD = "exclamation";

const PUNCTUATION_KIND = "punctuation";
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

const readPunctuation = (mark: string): FormatCommand => ({ kind: PUNCTUATION_KIND, mark });

// Longer phrases come first, so "new bullet point" wins over "new bullet" and "bullet".
const SPOKEN_COMMANDS: ReadonlyArray<SpokenCommand> = [
  { phrase: [EXCLAMATION_WORD, MARK_WORD], command: readPunctuation(EXCLAMATION_MARK) },
  { phrase: [EXCLAMATION_WORD, POINT_WORD], command: readPunctuation(EXCLAMATION_MARK) },
  { phrase: [NEXT_WORD, BULLET_WORD, POINT_WORD], command: { kind: BULLET_WORD } },
  { phrase: [NEW_WORD, BULLET_WORD, POINT_WORD], command: { kind: BULLET_WORD } },
  { phrase: ["numbered", LIST_WORD], command: { kind: NUMBERED_LIST_KIND } },
  { phrase: [NEW_WORD, "paragraph"], command: { kind: NEW_PARAGRAPH_KIND } },
  { phrase: ["question", MARK_WORD], command: readPunctuation(QUESTION_MARK) },
  { phrase: [BULLET_WORD, LIST_WORD], command: { kind: BULLET_WORD } },
  { phrase: [BULLET_WORD, POINT_WORD], command: { kind: BULLET_WORD } },
  { phrase: [NEXT_WORD, BULLET_WORD], command: { kind: BULLET_WORD } },
  { phrase: [NEW_WORD, BULLET_WORD], command: { kind: BULLET_WORD } },
  { phrase: [NEXT_WORD, "item"], command: { kind: NEXT_LIST_MARK_KIND } },
  { phrase: [NEXT_WORD, LINE_WORD], command: { kind: NEW_LINE_KIND } },
  { phrase: ["full", "stop"], command: readPunctuation(PERIOD_MARK) },
  { phrase: [NEW_WORD, LINE_WORD], command: { kind: NEW_LINE_KIND } },
  { phrase: ["semicolon"], command: readPunctuation(SEMICOLON_MARK) },
  { phrase: ["newline"], command: { kind: NEW_LINE_KIND } },
  { phrase: ["period"], command: readPunctuation(PERIOD_MARK) },
  { phrase: ["comma"], command: readPunctuation(",") },
  { phrase: ["colon"], command: readPunctuation(":") },
  { phrase: [BULLET_WORD], command: { kind: BULLET_WORD } },
  { phrase: ["dot"], command: readPunctuation(PERIOD_MARK) },
];

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
  const pairs = replacementWords.split(SEMICOLON_MARK).flatMap(listReplacementPair);
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

const readCommandAt = (spoken: Spoken, index: number): SpokenCommand | null =>
  SPOKEN_COMMANDS.find((spokenCommand) =>
    hasPhraseAt({ words: spoken.canonical, index, phrase: spokenCommand.phrase }),
  ) ?? null;

const readReplacementAt = (spoken: Spoken, index: number): Phrase | null =>
  spoken.phrases.find((phrase) => hasPhraseAt({ words: spoken.canonical, index, phrase: phrase.words })) ?? null;

// "literal" types the next command or replacement phrase, or one word, as plain words.
const readLiteralLength = (spoken: Spoken, index: number): number => {
  const command = readCommandAt(spoken, index);

  const hasCommand = command != null;
  if (hasCommand) {
    return command.phrase.length;
  }

  const replacement = readReplacementAt(spoken, index);

  const hasReplacement = replacement != null;
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
    return { piece: { kind: WORDS_PIECE_KIND, text: literal }, length: 1 + length };
  }

  const command = readCommandAt(spoken, index);

  const hasCommand = command != null;
  if (hasCommand) {
    return { piece: command.command, length: command.phrase.length };
  }

  const replacement = readReplacementAt(spoken, index);

  const hasReplacement = replacement != null;
  if (hasReplacement) {
    // The heard words' closing punctuation stays: "my name is Joseph." types "My name is Yosef."
    const lastHeard = spoken.words[index + replacement.words.length - 1];
    const closing = readTrailingPunctuation(lastHeard);
    return {
      piece: { kind: WORDS_PIECE_KIND, text: `${replacement.written}${closing}` },
      length: replacement.words.length,
    };
  }

  return { piece: { kind: WORDS_PIECE_KIND, text: spoken.words[index] }, length: 1 };
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
  const isNewList = kind === NUMBERED_LIST_KIND || formatStatus.nextNumber < 1;
  if (isNewList) {
    return 1;
  }

  return formatStatus.nextNumber;
};

const pushPiece = (formatStatus: FormatStatus, piece: Piece): FormatStatus => {
  switch (piece.kind) {
    case WORDS_PIECE_KIND:
      return pushWords(formatStatus, piece.text);
    case PUNCTUATION_KIND: {
      const endsSentence = [PERIOD_MARK, EXCLAMATION_MARK, QUESTION_MARK].includes(piece.mark);
      const string = `${formatStatus.text}${piece.mark}`;
      return { ...formatStatus, text: string, atLineStart: false, capitalizeNext: endsSentence, needsSpace: true };
    }
    case NEW_LINE_KIND:
      return readBreakLine(formatStatus, "\n");
    case NEW_PARAGRAPH_KIND:
      return readBreakLine(formatStatus, "\n\n");
    case BULLET_WORD: {
      const element = startListLine(formatStatus, "- ");
      return { ...element, nextNumber: 0 };
    }
    case NUMBERED_LIST_KIND:
    case NEXT_LIST_MARK_KIND: {
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
