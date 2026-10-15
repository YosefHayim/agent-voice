const sentence = (text: string): string => {
  const words = text.split(/\s+/u).filter(Boolean).join(" ");
  const isFinished = words === "" || /[.!?:;]$/u.test(words);
  if (isFinished) {
    return words;
  }

  return `${words}.`;
};

// Paired emphasis markers only (**bold**, *it*, _it_, ~~gone~~); a lone or escaped one (2 * 3, *.ts, snake_case) is text.
const withoutEmphasis = (text: string): string =>
  text
    .replace(/(?<![\\\p{L}\p{N}_*~])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, "$2")
    .replace(/(?<![\\\p{L}\p{N}_*~])([*_~])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, "$2");

const CODE_SPAN = /`([^`]*)`/gu;

// A private-use character marks where a code span was set aside, since no reply text contains it.
const SET_ASIDE = /(\d+)/gu;

// Code spans are set aside while emphasis and HTML tags are removed, so `Array<T>` and `__init__` stay as written.
const inlineSpeech = (text: string): string => {
  const linked = text
    .replace(/!\[\s*\]\(/gu, "![image](")
    .replace(/!\[\s*([^\]]*?)\s*\]\(\s*([^)]+?)\s*\)/gu, "Image: $1. Source $2")
    .replace(/\[\s*([^\]]+?)\s*\]\(\s*([^)]+?)\s*\)/gu, "$1, link $2")
    .replace(/<(https?:\/\/[^>]+)>/gu, "link $1");
  const codeSpans: Array<string> = [];
  const prose = linked.replace(CODE_SPAN, (_span, code: string) => {
    const spanIndex = codeSpans.push(code) - 1;
    return `${spanIndex}`;
  });
  return withoutEmphasis(prose)
    .replace(/<[^>]+>/gu, " ")
    .replace(SET_ASIDE, (_marker, spanIndex: string) => codeSpans[Number(spanIndex)] || "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
};

const proseSentence = (prefix: string, text: string): string => {
  const prose = inlineSpeech(text);
  return sentence(`${prefix}${prose}`);
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

const codeSpeech = (line: string): string => {
  const code = line.trim();
  if (code === "") {
    return "Blank line.";
  }

  const spoken = SPOKEN_SYMBOLS.reduce((text, [symbol, words]) => text.split(symbol).join(words), code);
  return sentence(spoken);
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

const codeStart = (language: string): string => {
  const name = LANGUAGE_NAMES[language.toLowerCase()] || language;
  return sentence(`Code block, ${name}`);
};

const FENCE = /^\s*```\s*([^\s`]*)/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const UNORDERED = /^\s*[-+*]\s+(.+)$/u;
const ORDERED = /^\s*([0-9]+)[.)]\s+(.+)$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const RULE = /^\s*(?:[-*_]\s*){3,}$/u;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u;

// Cells split at unescaped pipes; an escaped pipe (\|) is a literal "|" inside its cell.
const tableCells = (line: string): ReadonlyArray<string> =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/(?<!\\)\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => {
      const unescaped = cell.replaceAll("\\|", "|");
      return inlineSpeech(unescaped);
    });

const isTableStart = (line: string, nextLine: string | undefined): boolean =>
  line.includes("|") && nextLine !== undefined && TABLE_SEPARATOR.test(nextLine);

// One sentence per row: "Row 1. Item: Voice. State: Ready."
const tableSpeech = (header: string, rows: ReadonlyArray<string>): ReadonlyArray<string> => {
  const columns = tableCells(header);
  const cellSpeech = (cell: string, cellIndex: number): string => {
    const column = columns.at(cellIndex) || `Column ${cellIndex + 1}`;
    const value = cell || "empty";
    return sentence(`${column}: ${value}`);
  };
  return rows.map((row, rowIndex) => {
    const cells = tableCells(row).map(cellSpeech);
    return [`Row ${rowIndex + 1}.`, ...cells].join(" ");
  });
};

// A table runs until the first line without a cell separator.
const tableEnd = (lines: ReadonlyArray<string>, firstRow: number): number => {
  const end = lines.findIndex((line, index) => index >= firstRow && !line.includes("|"));
  if (end < 0) {
    return lines.length;
  }

  return end;
};

const lineSpeech = (line: string): string => {
  const isSilent = line.trim() === "" || RULE.test(line);
  if (isSilent) {
    return "";
  }

  const heading = HEADING.exec(line) || UNORDERED.exec(line);
  if (heading !== null) {
    return proseSentence("", heading[1] || "");
  }

  const ordered = ORDERED.exec(line);
  if (ordered !== null) {
    return proseSentence(`${ordered[1] || ""}. `, ordered[2] || "");
  }

  const quote = QUOTE.exec(line);
  if (quote !== null) {
    return proseSentence("Quote. ", quote[1] || "");
  }

  return proseSentence("", line);
};

// Nothing is dropped or truncated: every line becomes a sentence, and a table jumps past its own rows.
export const markdownToSpeech = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const spoken: Array<string> = [];
  let inCode = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || "";
    const fence = FENCE.exec(line);
    const isTable = fence === null && !inCode && isTableStart(line, lines[index + 1]);
    if (isTable) {
      const firstRow = index + 2;
      const end = tableEnd(lines, firstRow);
      const rows = lines.slice(firstRow, end);
      const rowSentences = tableSpeech(line, rows);
      spoken.push(...rowSentences);
      index = end;
      continue;
    }

    index += 1;
    if (fence !== null && inCode) {
      spoken.push(CODE_END);
      inCode = false;
      continue;
    }

    if (fence !== null) {
      const opening = codeStart(fence[1] || "");
      spoken.push(opening);
      inCode = true;
      continue;
    }

    if (inCode) {
      const codeSentence = codeSpeech(line);
      spoken.push(codeSentence);
      continue;
    }

    const lineSentence = lineSpeech(line);
    spoken.push(lineSentence);
  }
  if (inCode) {
    spoken.push(CODE_END);
  }

  return spoken.filter((spokenLine) => spokenLine !== "").join("\n");
};
