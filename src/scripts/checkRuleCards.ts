type RuleCardViolation = {
  ruleId: string;
  line: number;
  message: string;
};

type CheckRuleCardsRequest = {
  guide: string;
};

type SectionHeading = {
  title: string;
  line: number;
};

type CardRange = {
  heading: string;
  headingLine: number;
  start: number;
  end: number;
};

type ValidateCardRequest = {
  lines: ReadonlyArray<string>;
  card: CardRange;
};

const REQUIRED_SECTIONS = ["Rules", "Canonical example", "Golden path", "Exemplars", "Never"];

// e.g. "[rule:function.arrow-only] · verify: `pnpm style`" or "… · verify: judgment". IDs may use "-" and "_"
// so another repository can keep its existing IDs.
const METADATA_PATTERN = /^\[rule:([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)\] · verify: (?:`[^`]+`|judgment)$/u;

const FORMAT_RULE = "format.rule-card";

const sectionHeadings = (lines: ReadonlyArray<string>): ReadonlyArray<SectionHeading> =>
  lines
    .map((text, index) => ({ text, index }))
    .filter((entry) => entry.text.startsWith("## "))
    .map((entry) => ({ title: entry.text.slice(3).trim(), line: entry.index + 1 }));

const fencedLineNumbers = (lines: ReadonlyArray<string>): ReadonlySet<number> => {
  const fenced = new Set<number>();
  let inside = false;

  // Track fence state so headings inside example code are never read as structure.
  for (const [index, text] of lines.entries()) {
    if (text.startsWith("```")) {
      inside = !inside;
      fenced.add(index);
      continue;
    }

    if (inside) {
      fenced.add(index);
    }
  }

  return fenced;
};

const rulesSectionRange = (request: { lines: ReadonlyArray<string>; fenced: ReadonlySet<number> }) => {
  const start = request.lines.findIndex((text, index) => text.trim() === "## Rules" && !request.fenced.has(index));
  if (start < 0) {
    return undefined;
  }

  const nextSection = request.lines.findIndex(
    (text, index) => index > start && text.startsWith("## ") && !request.fenced.has(index),
  );

  if (nextSection < 0) {
    return { start, end: request.lines.length };
  }

  return { start, end: nextSection };
};

const ruleCardRanges = (request: {
  lines: ReadonlyArray<string>;
  fenced: ReadonlySet<number>;
  section: { start: number; end: number };
}): ReadonlyArray<CardRange> => {
  const headingIndexes = request.lines
    .map((text, index) => ({ text, index }))
    .filter(
      (entry) =>
        entry.index > request.section.start &&
        entry.index < request.section.end &&
        entry.text.startsWith("### ") &&
        !request.fenced.has(entry.index),
    )
    .map((entry) => entry.index);

  return headingIndexes.map((headingIndex, position) => ({
    heading: request.lines[headingIndex]?.slice(4).trim() || "",
    headingLine: headingIndex + 1,
    start: headingIndex,
    end: headingIndexes.at(position + 1) || request.section.end,
  }));
};

const firstContentIndex = (request: { lines: ReadonlyArray<string>; from: number; to: number }) =>
  request.lines.findIndex((text, index) => index >= request.from && index < request.to && text.trim().length > 0);

const codeBlockText = (request: { lines: ReadonlyArray<string>; from: number; to: number }) => {
  const open = request.lines.findIndex(
    (text, index) => index >= request.from && index < request.to && text.startsWith("```"),
  );
  if (open < 0) {
    return undefined;
  }

  const close = request.lines.findIndex((text, index) => index > open && index < request.to && text.startsWith("```"));
  if (close < 0) {
    return undefined;
  }

  return { text: request.lines.slice(open + 1, close).join("\n"), close };
};

const isSingleSentence = (assertion: string): boolean =>
  assertion.endsWith(".") && !assertion.includes(". ") && !/^[-*#|>`]/u.test(assertion);

const validateCard = (request: ValidateCardRequest): ReadonlyArray<RuleCardViolation> => {
  const { lines, card } = request;
  const metadataIndex = firstContentIndex({ lines, from: card.start + 1, to: card.end });
  const metadata = lines[metadataIndex]?.trim() || "";
  const match = METADATA_PATTERN.exec(metadata);
  if (!match) {
    return [
      {
        ruleId: FORMAT_RULE,
        line: card.headingLine,
        message: `Card "${card.heading}" needs a metadata line "[rule:<id>] · verify: \`<command>\`" or "… · verify: judgment".`,
      },
    ];
  }

  const id = match[1] || "";
  const assertionIndex = firstContentIndex({ lines, from: metadataIndex + 1, to: card.end });
  const assertion = lines[assertionIndex]?.trim() || "";
  if (assertionIndex < 0 || assertion.startsWith("```")) {
    return [
      {
        ruleId: id,
        line: card.headingLine,
        message: `Rule ${id} needs one assertion sentence between its metadata line and its example.`,
      },
    ];
  }

  const violations: Array<RuleCardViolation> = [];
  if (!isSingleSentence(assertion)) {
    violations.push({
      ruleId: id,
      line: assertionIndex + 1,
      message: `Rule ${id} must state exactly one sentence ending in a period; split a second sentence into its own rule.`,
    });
  }

  const block = codeBlockText({ lines, from: assertionIndex + 1, to: card.end });
  if (!block) {
    violations.push({
      ruleId: id,
      line: assertionIndex + 1,
      message: `Rule ${id} needs a fenced example block.`,
    });

    return violations;
  }

  if (!block.text.includes("// ✓")) {
    violations.push({ ruleId: id, line: block.close + 1, message: `Rule ${id} example needs a "// ✓" case.` });
  }

  if (!block.text.includes("// ✗")) {
    violations.push({ ruleId: id, line: block.close + 1, message: `Rule ${id} example needs a "// ✗" case.` });
  }

  const hasWhy = lines.slice(block.close + 1, card.end).some((text) => text.trim().startsWith("Why:"));
  if (!hasWhy) {
    violations.push({ ruleId: id, line: block.close + 1, message: `Rule ${id} needs a "Why:" line.` });
  }

  return violations;
};

const cardRuleId = (request: { lines: ReadonlyArray<string>; card: CardRange }): ReadonlyArray<string> => {
  const metadataIndex = firstContentIndex({ lines: request.lines, from: request.card.start + 1, to: request.card.end });
  const metadataLine = request.lines[metadataIndex] || "";
  const ruleId = METADATA_PATTERN.exec(metadataLine)?.[1];
  if (ruleId === undefined) {
    return [];
  }

  return [ruleId];
};

const cardRuleIds = (request: { lines: ReadonlyArray<string>; cards: ReadonlyArray<CardRange> }) =>
  request.cards.flatMap((card) => cardRuleId({ lines: request.lines, card }));

// The rules section is found by its exact heading (see rulesSectionRange); the others may carry a qualifier, as in
// "Golden path — adding a feature". A "## Rules — …" heading would otherwise pass here while every card went unchecked.
const hasSection = (headings: ReadonlyArray<SectionHeading>, section: string): boolean => {
  if (section === "Rules") {
    return headings.some((heading) => heading.title === section);
  }

  return headings.some((heading) => heading.title.startsWith(section));
};

const missingSectionViolations = (headings: ReadonlyArray<SectionHeading>): ReadonlyArray<RuleCardViolation> =>
  REQUIRED_SECTIONS.filter((section) => !hasSection(headings, section)).map((section) => ({
    ruleId: FORMAT_RULE,
    line: 1,
    message: `CODE-STYLE.md needs a "## ${section}" section.`,
  }));

const duplicateCardViolations = (documentedIds: ReadonlyArray<string>): ReadonlyArray<RuleCardViolation> => {
  const counts = new Map<string, number>();
  for (const id of documentedIds) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => ({
      ruleId: FORMAT_RULE,
      line: 1,
      message: `Rule ${id} has more than one card in CODE-STYLE.md.`,
    }));
};

export const ruleCardIds = (guide: string): ReadonlyArray<string> => {
  const lines = guide.split("\n");
  const fenced = fencedLineNumbers(lines);
  const section = rulesSectionRange({ lines, fenced });
  if (!section) {
    return [];
  }

  return cardRuleIds({ lines, cards: ruleCardRanges({ lines, fenced, section }) });
};

export const checkRuleCards = (request: CheckRuleCardsRequest): ReadonlyArray<RuleCardViolation> => {
  const lines = request.guide.split("\n");
  const fenced = fencedLineNumbers(lines);
  const headings = sectionHeadings(lines).filter((heading) => !fenced.has(heading.line - 1));
  const section = rulesSectionRange({ lines, fenced });
  const sectionProblems = missingSectionViolations(headings);
  if (!section) {
    return sectionProblems;
  }

  const cards = ruleCardRanges({ lines, fenced, section });
  const cardViolations = cards.flatMap((card) => validateCard({ lines, card }));

  const ruleIds = cardRuleIds({ lines, cards });
  const duplicateViolations = duplicateCardViolations(ruleIds);
  return [...sectionProblems, ...cardViolations, ...duplicateViolations].sort(
    (left, right) => left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  );
};
