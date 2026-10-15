/** Markdown → spoken prose: one sentence per line, tables read by column, code read symbol by symbol. */

const sentence = (text: string): string => {
  const clean = text.split(/\s+/u).filter(Boolean).join(" ");
  return clean === "" || /[.!?:;]$/u.test(clean) ? clean : `${clean}.`;
};

// Paired emphasis markers only (**bold**, *it*, _it_, ~~gone~~); a lone or escaped one (2 * 3, *.ts, snake_case) is text.
const withoutEmphasis = (text: string): string =>
  text
    .replace(/(?<![\\\p{L}\p{N}_*~])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, "$2")
    .replace(/(?<![\\\p{L}\p{N}_*~])([*_~])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, "$2");

const CODE_SPAN = /`([^`]*)`/gu;

/** A private-use character marks where a code span was set aside. */
const SET_ASIDE = /\uE000(\d+)\uE000/gu;

// Code spans are set aside while emphasis and HTML tags are removed, so `Array<T>` and `__init__` stay as written.
const inlineSpeech = (text: string): string => {
  const linked = text
    .replace(/!\[\s*\]\(/gu, "![image](")
    .replace(/!\[\s*([^\]]*?)\s*\]\(\s*([^)]+?)\s*\)/gu, "Image: $1. Source $2")
    .replace(/\[\s*([^\]]+?)\s*\]\(\s*([^)]+?)\s*\)/gu, "$1, link $2")
    .replace(/<(https?:\/\/[^>]+)>/gu, "link $1");
  const codeSpans: Array<string> = [];
  const prose = linked.replace(CODE_SPAN, (_span, code: string) => `\uE000${String(codeSpans.push(code) - 1)}\uE000`);
  return withoutEmphasis(prose)
    .replace(/<[^>]+>/gu, " ")
    .replace(SET_ASIDE, (_marker, index: string) => codeSpans[Number(index)] || "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
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

const codeSpeech = (line: string): string =>
  sentence(SPOKEN_SYMBOLS.reduce((spoken, [symbol, words]) => spoken.split(symbol).join(words), line.trim()));

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

const languageName = (token: string): string => LANGUAGE_NAMES[token.toLowerCase()] || token;

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
    .map((cell) => inlineSpeech(cell.replaceAll("\\|", "|")));

const isTableStart = (line: string, nextLine: string | undefined): boolean =>
  line.includes("|") && nextLine !== undefined && TABLE_SEPARATOR.test(nextLine);

/** A table read as one sentence per row: "Row 1. Item: Voice. State: Ready." */
const tableSpeech = (header: string, rows: ReadonlyArray<string>): ReadonlyArray<string> => {
  const columns = tableCells(header);
  return rows.map((row, rowIndex) => {
    const cells = tableCells(row).map((cell, cellIndex) => {
      const column = columns.at(cellIndex) || `Column ${String(cellIndex + 1)}`;
      return sentence(`${column}: ${cell === "" ? "empty" : cell}`);
    });
    return [`Row ${String(rowIndex + 1)}.`, ...cells].join(" ");
  });
};

// A table runs until the first line without a cell separator.
const tableEnd = (lines: ReadonlyArray<string>, firstRow: number): number => {
  const end = lines.findIndex((line, index) => index >= firstRow && !line.includes("|"));
  return end < 0 ? lines.length : end;
};

const lineSpeech = (line: string): string => {
  const heading = HEADING.exec(line) || UNORDERED.exec(line);
  if (heading !== null) {
    return sentence(inlineSpeech(heading[1] || ""));
  }

  const ordered = ORDERED.exec(line);
  if (ordered !== null) {
    return sentence(`${ordered[1] || ""}. ${inlineSpeech(ordered[2] || "")}`);
  }

  const quote = QUOTE.exec(line);
  return quote === null ? sentence(inlineSpeech(line)) : sentence(`Quote. ${inlineSpeech(quote[1] || "")}`);
};

/** Render Markdown into a speech document: newline-separated sentences, nothing dropped or truncated. */
export const markdownToSpeech = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const spoken: Array<string> = [];
  let inCode = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || "";
    const blank = line.trim() === "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      spoken.push(inCode ? "End code block." : sentence(`Code block, ${languageName(fence[1] || "")}`));
      inCode = !inCode;
    } else if (inCode) {
      spoken.push(blank ? "Blank line." : codeSpeech(line));
    } else if (isTableStart(line, lines[index + 1])) {
      const firstRow = index + 2;
      const end = tableEnd(lines, firstRow);
      spoken.push(...tableSpeech(line, lines.slice(firstRow, end)));
      index = end;
      continue;
    } else if (!blank && !RULE.test(line)) {
      spoken.push(lineSpeech(line));
    }
    index += 1;
  }
  if (inCode) {
    spoken.push("End code block.");
  }

  return spoken.filter((sentenceText) => sentenceText !== "").join("\n");
};
