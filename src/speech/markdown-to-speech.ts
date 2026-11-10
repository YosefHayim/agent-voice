const readSentence = (string: string): string => {
  const words = string.split(/\s+/u).filter(Boolean).join(" ");

  const isFinished = words === "" || /[.!?:;]$/u.test(words);
  if (isFinished) {
    return words;
  }

  return `${words}.`;
};

// Paired emphasis markers only (**bold**, *it*, _it_, ~~gone~~); a lone or escaped one (2 * 3, *.ts, snake_case) is text.
const stripEmphasis = (string: string): string =>
  string
    .replace(/(?<![\\\p{L}\p{N}_*~])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, "$2")
    .replace(/(?<![\\\p{L}\p{N}_*~])([*_~])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, "$2");

const CODE_SPAN = /`([^`]*)`/gu;

// A private-use character marks where a code span was set aside, since no reply text contains it.
const SET_ASIDE = /(\d+)/gu;

// Code spans are set aside while emphasis and HTML tags are removed, so `Array<T>` and `__init__` stay as written.
const readInlineSpeech = (string: string): string => {
  const linked = string
    .replace(/!\[\s*\]\(/gu, "![image](")
    .replace(/!\[\s*([^\]]*?)\s*\]\(\s*([^)]+?)\s*\)/gu, "Image: $1. Source $2")
    .replace(/\[\s*([^\]]+?)\s*\]\(\s*([^)]+?)\s*\)/gu, "$1, link $2")
    .replace(/<(https?:\/\/[^>]+)>/gu, "link $1");
  const codeSpans: Array<string> = [];
  const prose = linked.replace(CODE_SPAN, (_span, code: string) => {
    const spanIndex = codeSpans.push(code) - 1;
    return `${spanIndex}`;
  });
  return stripEmphasis(prose)
    .replace(/<[^>]+>/gu, " ")
    .replace(SET_ASIDE, (_marker, spanIndex: string) => codeSpans[Number(spanIndex)] || "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
};

const readProseSentence = (prefix: string, string: string): string => {
  const prose = readInlineSpeech(string);
  return readSentence(`${prefix}${prose}`);
};

// Longer symbols first, so "===" is never read as "==" plus "=".
const SPOKEN_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["===", " strictly equals "],
  ["!==", " does not strictly equal "],
  ["=>", " arrow "],
  ["==", " equals "],
  ["!=", " does not equal "],
  [">=", " greater than or equal to "],
  ["<=", " less than or equal to "],
  ["&&", " and "],
  ["||", " or "],
  ["=", " equals "],
  [";", " semicolon "],
  ["{", " open brace "],
  ["}", " close brace "],
  ["[", " open bracket "],
  ["]", " close bracket "],
];

const readCodeSpeech = (line: string): string => {
  const code = line.trim();

  const isCodeEmpty = code === "";
  if (isCodeEmpty) {
    return "Blank line.";
  }

  const spoken = SPOKEN_SYMBOLS.reduce((string, [symbol, words]) => string.split(symbol).join(words), code);
  return readSentence(spoken);
};

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  css: "CSS",
  html: "HTML",
  js: "JavaScript",
  javascript: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  md: "Markdown",
  markdown: "Markdown",
  sh: "Shell",
  sql: "SQL",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  yaml: "YAML",
  yml: "YAML",
  "": "code",
};

const CODE_END = "End code block.";

const readCodeStart = (language: string): string => {
  const name = LANGUAGE_NAMES[language.toLowerCase()] || language;
  return readSentence(`Code block, ${name}`);
};

const FENCE = /^\s*```\s*([^\s`]*)/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const UNORDERED = /^\s*[-+*]\s+(.+)$/u;
const ORDERED = /^\s*([0-9]+)[.)]\s+(.+)$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const RULE = /^\s*(?:[-*_]\s*){3,}$/u;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u;

// Cells split at unescaped pipes; an escaped pipe (\|) is a literal "|" inside its cell.
const listTableCells = (line: string): ReadonlyArray<string> =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/(?<!\\)\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => {
      const unescaped = cell.replaceAll("\\|", "|");
      return readInlineSpeech(unescaped);
    });

const isTableStart = (line: string, nextLine: string | undefined): boolean =>
  line.includes("|") && nextLine !== undefined && TABLE_SEPARATOR.test(nextLine);

// One sentence per row: "Row 1. Item: Voice. State: Ready."
const listTableSpeech = (header: string, storedList: ReadonlyArray<string>): ReadonlyArray<string> => {
  const columns = listTableCells(header);
  const readCellSpeech = (cell: string, cellIndex: number): string => {
    const column = columns.at(cellIndex) || `Column ${cellIndex + 1}`;
    const field = cell || "empty";
    return readSentence(`${column}: ${field}`);
  };
  return storedList.map((stored, storedIndex) => {
    const cells = listTableCells(stored).map(readCellSpeech);
    return [`Row ${storedIndex + 1}.`, ...cells].join(" ");
  });
};

// A table runs until the first line without a cell separator.
const readTableEnd = (lines: ReadonlyArray<string>, storedFirst: number): number => {
  const end = lines.findIndex((line, index) => index >= storedFirst && !line.includes("|"));

  const isEndNotFound = end < 0;
  if (isEndNotFound) {
    return lines.length;
  }

  return end;
};

const readLineSpeech = (line: string): string => {
  const isSilent = line.trim() === "" || RULE.test(line);
  if (isSilent) {
    return "";
  }

  const heading = HEADING.exec(line) || UNORDERED.exec(line);

  const hasHeading = heading !== null;
  if (hasHeading) {
    return readProseSentence("", heading[1] || "");
  }

  const ordered = ORDERED.exec(line);

  const hasOrdered = ordered !== null;
  if (hasOrdered) {
    return readProseSentence(`${ordered[1] || ""}. `, ordered[2] || "");
  }

  const quote = QUOTE.exec(line);

  const hasQuote = quote !== null;
  if (hasQuote) {
    return readProseSentence("Quote. ", quote[1] || "");
  }

  return readProseSentence("", line);
};

// Nothing is dropped or truncated: every line becomes a sentence, and a table jumps past its own rows.
export const convertMarkdownToSpeech = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const spoken: Array<string> = [];
  let inCode = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || "";
    const fence = FENCE.exec(line);

    const isTable = fence === null && !inCode && isTableStart(line, lines[index + 1]);
    if (isTable) {
      const storedFirst = index + 2;
      const end = readTableEnd(lines, storedFirst);
      const storedList = lines.slice(storedFirst, end);
      const storedSentences = listTableSpeech(line, storedList);
      spoken.push(...storedSentences);
      index = end;
      continue;
    }

    index += 1;

    const isInsideCodeFence = fence !== null && inCode;
    if (isInsideCodeFence) {
      spoken.push(CODE_END);
      inCode = false;
      continue;
    }

    const hasFence = fence !== null;
    if (hasFence) {
      const opening = readCodeStart(fence[1] || "");
      spoken.push(opening);
      inCode = true;
      continue;
    }

    if (inCode) {
      const codeSentence = readCodeSpeech(line);
      spoken.push(codeSentence);
      continue;
    }

    const lineSentence = readLineSpeech(line);
    spoken.push(lineSentence);
  }

  if (inCode) {
    spoken.push(CODE_END);
  }

  return spoken.filter((spokenLine) => spokenLine !== "").join("\n");
};
