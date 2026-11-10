const NEWLINE = "\n";

const YAML_SPOKEN_NAME = "YAML";

const TYPESCRIPT_SPOKEN_NAME = "TypeScript";

const MARKDOWN_SPOKEN_NAME = "Markdown";

const JAVASCRIPT_SPOKEN_NAME = "JavaScript";

const EQUALS_SPOKEN_PHRASE = " equals ";

const SECOND_GROUP_REFERENCE = "$2";

const SPACE = " ";

const PIPE_CHARACTER = "|";

const readSentence = (string: string): string => {
  const words = string.split(/\s+/u).filter(Boolean).join(SPACE);

  const isFinished = words === "" || /[.!?:;]$/u.test(words);
  if (isFinished) {
    return words;
  }

  return `${words}.`;
};

// Paired emphasis markers only (**bold**, *it*, _it_, ~~gone~~); a lone or escaped one (2 * 3, *.ts, snake_case) is text.
const stripEmphasis = (string: string): string =>
  string
    .replace(/(?<![\\\p{L}\p{N}_*~])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, SECOND_GROUP_REFERENCE)
    .replace(/(?<![\\\p{L}\p{N}_*~])([*_~])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_*~])/gu, SECOND_GROUP_REFERENCE);

// Code spans are set aside while emphasis and HTML tags are removed, so `Array<T>` and `__init__` stay as written.
const readInlineSpeech = (string: string): string => {
  const linked = string
    .replace(/!\[\s*\]\(/gu, "![image](")
    .replace(/!\[\s*([^\]]*?)\s*\]\(\s*([^)]+?)\s*\)/gu, "Image: $1. Source $2")
    .replace(/\[\s*([^\]]+?)\s*\]\(\s*([^)]+?)\s*\)/gu, "$1, link $2")
    .replace(/<(https?:\/\/[^>]+)>/gu, "link $1");
  const codeSpans: Array<string> = [];
  const prose = linked.replace(/`([^`]*)`/gu, (_span, code: string) => {
    const spanIndex = codeSpans.push(code) - 1;
    return `${spanIndex}`;
  });

  return stripEmphasis(prose)
    .replace(/<[^>]+>/gu, SPACE)
    .replace(/(\d+)/gu, (_marker, spanIndex: string) => codeSpans[Number(spanIndex)] || "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(SPACE);
};

const readProseSentence = (prefix: string, string: string): string => {
  const prose = readInlineSpeech(string);
  return readSentence(`${prefix}${prose}`);
};

const readCodeSpeech = (line: string): string => {
  const code = line.trim();

  const isCodeEmpty = code === "";
  if (isCodeEmpty) {
    return "Blank line.";
  }

  // Longer symbols first, so "===" is never read as "==" plus "=".
  const spoken = [
    ["===", " strictly equals "],
    ["!==", " does not strictly equal "],
    ["=>", " arrow "],
    ["==", EQUALS_SPOKEN_PHRASE],
    ["!=", " does not equal "],
    [">=", " greater than or equal to "],
    ["<=", " less than or equal to "],
    ["&&", " and "],
    ["||", " or "],
    ["=", EQUALS_SPOKEN_PHRASE],
    [";", " semicolon "],
    ["{", " open brace "],
    ["}", " close brace "],
    ["[", " open bracket "],
    ["]", " close bracket "],
  ].reduce((string, [symbol, words]) => string.split(symbol).join(words), code);
  return readSentence(spoken);
};

const CODE_END = "End code block.";

const readCodeStart = (language: string): string => {
  const name =
    {
      bash: "Bash",
      css: "CSS",
      html: "HTML",
      js: JAVASCRIPT_SPOKEN_NAME,
      javascript: JAVASCRIPT_SPOKEN_NAME,
      json: "JSON",
      jsx: "JSX",
      md: MARKDOWN_SPOKEN_NAME,
      markdown: MARKDOWN_SPOKEN_NAME,
      sh: "Shell",
      sql: "SQL",
      ts: TYPESCRIPT_SPOKEN_NAME,
      typescript: TYPESCRIPT_SPOKEN_NAME,
      tsx: "TSX",
      yaml: YAML_SPOKEN_NAME,
      yml: YAML_SPOKEN_NAME,
      "": "code",
    }[language.toLowerCase()] || language;

  return readSentence(`Code block, ${name}`);
};

// Cells split at unescaped pipes; an escaped pipe (\|) is a literal "|" inside its cell.
const listTableCells = (line: string): ReadonlyArray<string> =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/(?<!\\)\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => {
      const unescaped = cell.replaceAll("\\|", PIPE_CHARACTER);
      return readInlineSpeech(unescaped);
    });

const isTableStart = (line: string, nextLine: string | undefined): boolean =>
  line.includes(PIPE_CHARACTER) &&
  nextLine != null &&
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(nextLine);

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
    return [`Row ${storedIndex + 1}.`, ...cells].join(SPACE);
  });
};

const readTableEnd = (lines: ReadonlyArray<string>, storedFirst: number): number => {
  const end = lines.findIndex((line, index) => index >= storedFirst && !line.includes(PIPE_CHARACTER));

  const isEndNotFound = end < 0;
  if (isEndNotFound) {
    return lines.length;
  }

  return end;
};

const readLineSpeech = (line: string): string => {
  const isSilent = line.trim() === "" || /^\s*(?:[-*_]\s*){3,}$/u.test(line);
  if (isSilent) {
    return "";
  }

  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line) || /^\s*[-+*]\s+(.+)$/u.exec(line);

  const hasHeading = heading != null;
  if (hasHeading) {
    return readProseSentence("", heading[1] || "");
  }

  const ordered = /^\s*([0-9]+)[.)]\s+(.+)$/u.exec(line);

  const hasOrdered = ordered != null;
  if (hasOrdered) {
    return readProseSentence(`${ordered[1] || ""}. `, ordered[2] || "");
  }

  const quote = /^\s*>\s?(.*)$/u.exec(line);

  const hasQuote = quote != null;
  if (hasQuote) {
    return readProseSentence("Quote. ", quote[1] || "");
  }

  return readProseSentence("", line);
};

// Nothing is dropped or truncated: every line becomes a sentence, and a table jumps past its own rows.
export const convertMarkdownToSpeech = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/gu, NEWLINE).split(NEWLINE);
  const spoken: Array<string> = [];
  let inCode = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || "";
    const fence = /^\s*```\s*([^\s`]*)/u.exec(line);

    const isTable = fence == null && !inCode && isTableStart(line, lines[index + 1]);
    if (isTable) {
      const indexAfterPrefix = 2;

      const storedFirst = index + indexAfterPrefix;
      const end = readTableEnd(lines, storedFirst);
      const storedList = lines.slice(storedFirst, end);
      const storedSentences = listTableSpeech(line, storedList);
      spoken.push(...storedSentences);
      index = end;
      continue;
    }

    index += 1;

    const isInsideCodeFence = fence != null && inCode;
    if (isInsideCodeFence) {
      spoken.push(CODE_END);
      inCode = false;
      continue;
    }

    const hasFence = fence != null;
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

  return spoken.filter((spokenLine) => spokenLine !== "").join(NEWLINE);
};
