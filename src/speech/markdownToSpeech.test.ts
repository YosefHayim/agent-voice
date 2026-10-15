import { describe, expect, it } from "vitest";

import { markdownToSpeech } from "./markdownToSpeech.js";

describe("markdownToSpeech", () => {
  it("reads a heading and a paragraph as sentences and drops emphasis markers", () => {
    expect(markdownToSpeech("# Hello\n\nWorld **bold**")).toBe("Hello.\nWorld bold.");
  });

  it("announces a code block with its language and reads code symbol by symbol", () => {
    expect(markdownToSpeech("```ts\nconst x = 1;\n\nif (a === b) {}\n```")).toBe(
      [
        "Code block, TypeScript.",
        "const x equals 1 semicolon.",
        "Blank line.",
        "if (a strictly equals b) open brace close brace.",
        "End code block.",
      ].join("\n"),
    );
  });

  it("closes a code block the reply never closed", () => {
    expect(markdownToSpeech("```\nrun it")).toBe("Code block, code.\nrun it.\nEnd code block.");
  });

  it("keeps links, images, autolinks, and inline code understandable", () => {
    expect(
      markdownToSpeech("See [the docs](https://example.com/a) and ![](x.png) or <https://b.dev> `pnpm verify`"),
    ).toBe(
      "See the docs, link https://example.com/a and Image: image. Source x.png or link https://b.dev pnpm verify.",
    );
  });

  it("reads lists, numbered items, and quotes, and skips horizontal rules", () => {
    expect(markdownToSpeech("- first\n2) second\n> careful\n---\n* last")).toBe(
      "first.\n2. second.\nQuote. careful.\nlast.",
    );
  });

  it("reads a table row by row with its column names", () => {
    const table = "| Item | State |\n| --- | :---: |\n| Voice | Ready |\n| Refine | |\n\nDone";
    expect(markdownToSpeech(table)).toBe(
      ["Row 1. Item: Voice. State: Ready.", "Row 2. Item: Refine. State: empty.", "Done."].join("\n"),
    );
  });

  it("keeps an escaped emphasis marker", () => {
    expect(markdownToSpeech("2 \\* 3")).toBe("2 \\* 3.");
  });

  it("drops paired emphasis only, so math, globs, and snake_case keep their symbols", () => {
    expect(markdownToSpeech("Use *care*: 2 * 3, *.ts, snake_case_name, __bold__ and ~~old~~")).toBe(
      "Use care: 2 * 3, *.ts, snake_case_name, bold and old.",
    );
  });

  it("reads inline code as written, generics and dunders included, even inside bold", () => {
    expect(markdownToSpeech("Return **`Array<T>`** from `__init__` <br>")).toBe("Return Array<T> from __init__.");
  });

  it("keeps an escaped pipe inside its table cell", () => {
    const table = "| Operator | Meaning |\n| --- | --- |\n| `a \\|\\| b` | either one |";
    expect(markdownToSpeech(table)).toBe("Row 1. Operator: a || b. Meaning: either one.");
  });
});
