import type { CommandSpec, FlagSpec, PositionalSpec } from "./command-spec.js";

interface HelpRow {
  readonly label: string;
  readonly description: string;
}

const INDENT = "  ";

const flagUsage = (flagName: string, flag: FlagSpec): string => {
  const isBooleanFlag = flag.kind === "boolean";
  if (isBooleanFlag) {
    return `--${flagName}`;
  }

  const isFlagChoicesMissing = flag.choices == null;
  const placeholderName = isFlagChoicesMissing ? flag.kind : flag.choices.join("|");
  return `--${flagName} <${placeholderName}>`;
};

const readPositionalUsage = (positionalSpec: PositionalSpec): string => {
  if (positionalSpec.isRequired) {
    return `<${positionalSpec.name}>`;
  }

  return `[${positionalSpec.name}]`;
};

const readUsageLabel = (commandPath: string, command: CommandSpec): string => {
  const isGroup = command.subcommands != null;
  if (isGroup) {
    return `${commandPath} <command>`;
  }

  if (command.isPassthrough) {
    return `${commandPath} [arguments]`;
  }

  const flagParts = Object.entries(command.flags).map(([flagName, flag]) => flagUsage(flagName, flag));
  const positionalParts = command.positionals.map(readPositionalUsage);
  return [commandPath, ...flagParts, ...positionalParts].join(" ");
};

const listTableLines = (rows: ReadonlyArray<HelpRow>): ReadonlyArray<string> => {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  return rows.map((row) => `${INDENT}${row.label.padEnd(labelWidth)}  ${row.description}`);
};

const listSectionLines = (title: string, rows: ReadonlyArray<HelpRow>): ReadonlyArray<string> => {
  const isEmptySection = rows.length === 0;
  if (isEmptySection) {
    return [];
  }

  return ["", `${title}:`, ...listTableLines(rows)];
};

export const createRootHelp = (commands: ReadonlyArray<CommandSpec>): string => {
  const commandRows = commands.map((command) => ({
    label: readUsageLabel(command.name, command),
    description: command.description,
  }));
  return [
    "agent-voice · Hold Shift to dictate into any text field and hear coding-agent replies read aloud.",
    "",
    "Usage: agent-voice <command> [options]",
    ...listSectionLines("Commands", commandRows),
    "",
    "Run agent-voice <command> --help for the options of one command.",
  ].join("\n");
};

export const createCommandHelp = (commandPath: string, command: CommandSpec): string => {
  const subcommandRows = (command.subcommands ?? []).map((subcommand) => ({
    label: readUsageLabel(subcommand.name, subcommand),
    description: subcommand.description,
  }));
  const positionalRows = command.positionals.map((positionalSpec) => ({
    label: readPositionalUsage(positionalSpec),
    description: positionalSpec.description,
  }));
  const flagRows = Object.entries(command.flags).map(([flagName, flag]) => ({
    label: flagUsage(flagName, flag),
    description: flag.description,
  }));
  return [
    `${commandPath} — ${command.description}`,
    "",
    `Usage: ${readUsageLabel(commandPath, command)}`,
    ...listSectionLines("Commands", subcommandRows),
    ...listSectionLines("Arguments", positionalRows),
    ...listSectionLines("Options", flagRows),
  ].join("\n");
};
