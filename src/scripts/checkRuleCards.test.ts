import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkRuleCards, ruleCardIds } from "./checkRuleCards.js";
import { repositoryRoot } from "./testFolder.js";

const guidePath = path.join(repositoryRoot, "CODE-STYLE.md");

const card = (request: { id: string; verify: string; assertion: string }) =>
  [
    `### ${request.id}`,
    `[rule:${request.id}] · verify: ${request.verify}`,
    "",
    request.assertion,
    "",
    "```ts",
    "// ✓ good",
    "const value = 1;",
    "",
    "// ✗ bad",
    "var value = 1;",
    "```",
    "",
    "Why: one reason.",
  ].join("\n");

const guideWith = (cards: ReadonlyArray<string>) =>
  [
    "# Style",
    "",
    "## Rules",
    "",
    ...cards,
    "",
    "## Canonical example",
    "",
    "## Golden path — adding a feature",
    "",
    "## Exemplars",
    "",
    "## Never",
    "",
  ].join("\n");

const validCards = [
  card({
    id: "function.arrow-only",
    verify: "`pnpm style`",
    assertion: "Named functions are arrow constants declared before first use.",
  }),
  card({
    id: "function.one-job",
    verify: "judgment",
    assertion: "A function performs one job its name fully describes.",
  }),
];

const validGuide = guideWith(validCards);

const messagesFor = (guide: string) => checkRuleCards({ guide }).map((violation) => violation.message);

describe("the repository style guide", () => {
  const guide = readFileSync(guidePath, "utf8");

  it("matches the rule-card format", () => {
    expect(checkRuleCards({ guide })).toEqual([]);
  });

  it("points every Never entry at a real rule", () => {
    const cardIds = ruleCardIds(guide);
    const neverStart = guide.indexOf("\n## Never");
    const neverSection = guide.slice(neverStart);
    const referenced = [...neverSection.matchAll(/\[rule:([a-z0-9.-]+)\]/gu)].flatMap((match) => match[1] || []);

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((ruleId) => !cardIds.includes(ruleId))).toEqual([]);
  });

  it("shows the queued reply schema-first, with the handwritten shape only as the rejected case", () => {
    const cardStart = guide.indexOf("[rule:type.schema-owned-runtime]");
    const schemaCard = guide.slice(cardStart);
    const codeEnd = schemaCard.indexOf("\n```\n");
    const [chosen = "", rejected = ""] = schemaCard.slice(0, codeEnd).split("// ✗");

    expect(chosen).toContain("export const queuedReplySchema = Schema.Struct({");
    expect(chosen).toContain("Schema.Schema.Type<typeof queuedReplySchema>");
    expect(chosen).not.toMatch(/type\s+QueuedReply\s*=\s*\{/u);
    expect(rejected).toMatch(/type\s+QueuedReply\s*=\s*\{/u);
  });
});

describe("rule-card format", () => {
  it("accepts a conforming guide", () => {
    expect(checkRuleCards({ guide: validGuide })).toEqual([]);
  });

  it("lists rule IDs in document order", () => {
    expect(ruleCardIds(validGuide)).toEqual(["function.arrow-only", "function.one-job"]);
  });

  it("requires every listed section", () => {
    const guide = validGuide.replace("## Never\n", "");

    expect(messagesFor(guide)).toContain('CODE-STYLE.md needs a "## Never" section.');
  });

  it("requires the exact Rules heading, so a qualified one cannot hide every card", () => {
    const guide = validGuide.replace("## Rules\n", "## Rules — draft\n");

    expect(messagesFor(guide)).toContain('CODE-STYLE.md needs a "## Rules" section.');
  });

  it("requires a metadata line under each card heading", () => {
    const guide = validGuide.replace("[rule:function.arrow-only] · verify: `pnpm style`\n", "");

    expect(messagesFor(guide).join("\n")).toMatch(/needs a metadata line/u);
  });

  it("rejects an assertion that runs to a second sentence", () => {
    const guide = guideWith([
      card({
        id: "function.arrow-only",
        verify: "`pnpm style`",
        assertion: "Named functions are arrow constants. Declare them before first use.",
      }),
      validCards.at(1) || "",
    ]);

    expect(messagesFor(guide).join("\n")).toMatch(/exactly one sentence/u);
  });

  it("rejects an assertion missing its period", () => {
    const guide = guideWith([
      card({
        id: "function.arrow-only",
        verify: "`pnpm style`",
        assertion: "Named functions are arrow constants declared before first use",
      }),
      validCards.at(1) || "",
    ]);

    expect(messagesFor(guide).join("\n")).toMatch(/exactly one sentence/u);
  });

  it.each([
    { name: "the chosen case", marker: "// ✓ good", expected: 'Rule function.arrow-only example needs a "// ✓" case.' },
    {
      name: "the rejected case",
      marker: "// ✗ bad",
      expected: 'Rule function.arrow-only example needs a "// ✗" case.',
    },
  ])("requires $name in the example", ({ marker, expected }) => {
    const guide = validGuide.replace(`${marker}\n`, "");

    expect(messagesFor(guide)).toContain(expected);
  });

  it("requires a Why line", () => {
    const guide = validGuide.replace("Why: one reason.\n", "");

    expect(messagesFor(guide)).toContain('Rule function.arrow-only needs a "Why:" line.');
  });

  it("requires a fenced example", () => {
    const guide = guideWith([
      [
        "### function.arrow-only",
        "[rule:function.arrow-only] · verify: `pnpm style`",
        "",
        "Named functions are arrow constants declared before first use.",
        "",
        "Why: one reason.",
      ].join("\n"),
      validCards.at(1) || "",
    ]);

    expect(messagesFor(guide)).toContain("Rule function.arrow-only needs a fenced example block.");
  });

  it("reports a duplicated card", () => {
    const guide = guideWith([...validCards, validCards.at(0) || ""]);

    expect(messagesFor(guide)).toContain("Rule function.arrow-only has more than one card in CODE-STYLE.md.");
  });

  it("accepts an existing snake_case ID rather than forcing a rename", () => {
    const guide = guideWith([card({ id: "shell.no_eval", verify: "judgment", assertion: "Something asserted." })]);

    expect(checkRuleCards({ guide })).toEqual([]);
  });

  it("ignores headings that appear inside example code", () => {
    const guide = validGuide.replace("// ✓ good", "// ✓ good\n### not a card\n## not a section");

    expect(checkRuleCards({ guide })).toEqual([]);
  });
});
