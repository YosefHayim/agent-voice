import { describe, expect, it } from "vitest";

import {
  checkRefinedPrompt,
  isAuthFailureString,
  isCliHelpString,
  isFailedModelPrintoutString,
  isModelUnavailableError,
  isQuotaOrLimitError,
  listPromptLiterals,
  replyStringFromDocument,
} from "./refine-reply.js";

const openCodeHelpDump =
  "opencode run [message..]\n\nrun opencode with a message\n\nPositionals:\n  message  message to send\n\nOptions:\n  -h, --help  show help  [boolean]";

const storedVerdictList: ReadonlyArray<readonly [string, (string: string) => boolean, string, boolean]> = [
  [
    "model unavailable",
    isModelUnavailableError,
    "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
    true,
  ],
  ["model unavailable", isModelUnavailableError, "rate limited try again", false],
  ["quota", isQuotaOrLimitError, "ERROR: exceeded your current quota / rate_limit 429", true],
  ["quota", isQuotaOrLimitError, "can only afford 100 tokens", true],
  ["quota", isQuotaOrLimitError, "connection refused", false],
  ["quota", isQuotaOrLimitError, "Budget has been exceeded! Current cost: 5.2, Max budget: 5.0", true],
  ["quota", isQuotaOrLimitError, "You exceeded your current quota, please check your plan and billing details.", true],
  ["quota", isQuotaOrLimitError, "Rate limit reached for gpt-4 on tokens per min (TPM): Limit 10000", true],
  ["quota", isQuotaOrLimitError, "Quota exceeded for quota metric 'Generate Content API requests per minute'", true],
  [
    "quota",
    isQuotaOrLimitError,
    "Set the monthly budget, fix the billing page, and show the disk quota on the RPM and TPM charts.",
    false,
  ],
  ["auth", isAuthFailureString, "No API key found for the selected model.\nUse /login", true],
  [
    "failed output",
    isFailedModelPrintoutString,
    "Not signed in. To authenticate without a browser, run:\n  grok login",
    true,
  ],
  ["auth", isAuthFailureString, "Ship the fix for STT refine", false],
  ["failed output", isFailedModelPrintoutString, '402: {"message":"requires more credits","code":402}', true],
  ["failed output", isFailedModelPrintoutString, '{"error":{"message":"bad"}}', true],
  ["failed output", isFailedModelPrintoutString, "", true],
  ["failed output", isFailedModelPrintoutString, "Fix the STT refine help paste bug.", false],
  ["CLI help", isCliHelpString, openCodeHelpDump, true],
  ["CLI help", isCliHelpString, "Ship the fix for STT refine", false],
];

const verdicts = storedVerdictList.map(([kind, judge, text, expected]) => ({ kind, judge, text, expected }));

describe("refine reply checks", () => {
  it.each(verdicts)("$kind: $text → $expected", ({ judge, text, expected }) => {
    expect(judge(text)).toBe(expected);
  });

  it("keeps code, paths, URLs, and quoted literals, and rejects replies that drop one or are CLI help", () => {
    const draft = 'Please run `pnpm verify` for /srv/app and keep "exact value" from https://example.com/docs';

    expect(checkRefinedPrompt({ draft, refined: `Precisely ${draft}` })).toEqual({
      status: "accepted",
      prompt: `Precisely ${draft}`,
    });
    const dropped = checkRefinedPrompt({ draft, refined: "Please verify it." });
    expect(dropped).toEqual({
      status: "rejected",
      rejection: { reason: "droppedLiteral", literal: "`pnpm verify`" },
    });
    const help = checkRefinedPrompt({ draft: "uh fix the thing", refined: openCodeHelpDump });
    expect(help).toMatchObject({ status: "rejected", rejection: { reason: "cliHelp" } });
    const empty = checkRefinedPrompt({ draft: "fix it", refined: "  " });
    expect(empty).toMatchObject({ status: "rejected", rejection: { reason: "empty" } });
  });

  it("strips a code fence around the whole reply", () => {
    expect(checkRefinedPrompt({ draft: "fix the bug", refined: "```\nFix the login bug.\n```" })).toEqual({
      status: "accepted",
      prompt: "Fix the login bug.",
    });
  });

  it("finds each literal once, earlier patterns first", () => {
    expect(listPromptLiterals("open `src/app.ts` then ./run.sh and 'quoted'")).toEqual([
      "`src/app.ts`",
      "./run.sh",
      "'quoted'",
    ]);
    expect(listPromptLiterals("word/like and abc/def/ghi")).toEqual(["word/like", "abc/def/ghi"]);
  });

  it("protects a quote that contains a URL or a path as a whole, so the model cannot reword it", () => {
    const draft = 'reply with "see https://x.dev/docs for details" exactly';
    expect(listPromptLiterals(draft)).toEqual(['"see https://x.dev/docs for details"']);

    const reworded = checkRefinedPrompt({ draft, refined: 'Reply with "read https://x.dev/docs for details".' });
    expect(reworded).toMatchObject({ status: "rejected", rejection: { reason: "droppedLiteral" } });
  });
});

describe("replyTextFromJson", () => {
  it("extracts the reply text from OpenCode JSONL events", () => {
    const jsonl = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"Ship the fix for STT refine"}}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
    ].join("\n");
    expect(replyStringFromDocument(jsonl)).toBe("Ship the fix for STT refine");
  });

  it("prefers the longest cumulative streamed part", () => {
    const jsonl = ['{"part":{"text":"Ship"}}', '{"part":{"text":"Ship the fix"}}'].join("\n");
    expect(replyStringFromDocument(jsonl)).toBe("Ship the fix");
  });

  it("reads one whole JSON document, a JSON string, Claude content blocks, and the last JSONL message", () => {
    expect(replyStringFromDocument('{"result":"  Done.  "}')).toBe("Done.");
    expect(replyStringFromDocument('"plain"')).toBe("plain");
    expect(replyStringFromDocument('{"content":[{"type":"text","text":"A"},{"type":"text","text":"B"}]}')).toBe("A\nB");
    expect(replyStringFromDocument('{"response":{"text":"nested"}}')).toBe("nested");
    const messageLines = ['{"message":{"content":"first"}}', '{"message":{"content":[{"text":"second"}]}}'].join("\n");
    expect(replyStringFromDocument(messageLines)).toBe("second");
    expect(replyStringFromDocument("not json")).toBe("");
  });
});
