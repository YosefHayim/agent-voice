import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRuleCards, ruleCardIds } from "./checkRuleCards.js";

const repositoryPath = process.argv[2] || process.cwd();
const repositoryRoot = resolve(repositoryPath);
const guidePath = join(repositoryRoot, "CODE-STYLE.md");

const reportRuleCards = (): void => {
  if (!existsSync(guidePath)) {
    process.stdout.write(`${repositoryRoot}\n  missing: ${guidePath}\n`);
    process.exitCode = 1;
    return;
  }

  const guide = readFileSync(guidePath, "utf8");
  const violations = checkRuleCards({ guide });
  for (const violation of violations) {
    process.stdout.write(`  CODE-STYLE.md:${violation.line}  ${violation.message}\n`);
  }

  const cardCount = ruleCardIds(guide).length;
  if (violations.length === 0) {
    process.stdout.write(`${repositoryRoot}\n  OK — ${cardCount} rule card(s) conform\n`);
    return;
  }

  process.stdout.write(
    `${repositoryRoot}\n  ${violations.length} format violation(s) across ${cardCount} rule card(s)\n`,
  );
  process.exitCode = 1;
};

reportRuleCards();
