import { checkCodeStyle } from "./checkCodeStyle.js";

const repositoryRoot = process.cwd();
const violations = checkCodeStyle(repositoryRoot);
const countsByRule = new Map<string, number>();
for (const violation of violations) {
  process.stdout.write(`${violation.file}:${violation.line}  ${violation.ruleId}  ${violation.message}\n`);
  const count = countsByRule.get(violation.ruleId) || 0;
  countsByRule.set(violation.ruleId, count + 1);
}

const summary = [...countsByRule]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .map(([ruleId, count]) => `  ${String(count).padStart(4)}  ${ruleId}`)
  .join("\n");
if (violations.length === 0) {
  process.stdout.write("\nMaintained application, tooling, and placement rules are clean.\n");
} else {
  process.stdout.write(`\n${violations.length} violation(s)\n${summary}\n`);
  process.exitCode = 1;
}
