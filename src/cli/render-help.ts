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

const positionalUsage = (positionalSpec: PositionalSpec): string => {
  if (positionalSpec.isRequired) {
    return `<${positionalSpec.name}>`;
  }

  return `[${positionalSpec.name}]`;
};

const usageLabel = (commandPath: string, command: CommandSpec): string => {
  const isGroup = command.subcommands != null;
  if (isGroup) {
    return `${commandPath} <command>`;
  }

  if (command.isPassthrough) {
    return `${commandPath} [arguments]`;
  }

  const flagParts = Object.entries(command.flags).map(([flagName, flag]) => flagUsage(flagName, flag));
  const positionalParts = command.positionals.map(positionalUsage);
  return [commandPath, ...flagParts, ...positionalParts].join(" ");
};

const tableLines = (rows: ReadonlyArray<HelpRow>): ReadonlyArray<string> => {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  return rows.map((row) => `${INDENT}${row.label.padEnd(labelWidth)}  ${row.description}`);
};

const sectionLines = (title: string, rows: ReadonlyArray<HelpRow>): ReadonlyArray<string> => {
  const isEmptySection = rows.length === 0;
  if (isEmptySection) {
    return [];
  }

  return ["", `${title}:`, ...tableLines(rows)];
};

export const renderRootHelp = (commands: ReadonlyArray<CommandSpec>): string => {
  const commandRows = commands.map((command) => ({
    label: usageLabel(command.name, command),
    description: command.description,
  }));
  return [
    "agent-voice · Hold Shift to dictate into any text field and hear coding-agent replies read aloud.",
    "",
    "Usage: agent-voice <command> [options]",
    ...sectionLines("Commands", commandRows),
    "",
    "Run agent-voice <command> --help for the options of one command.",
  ].join("\n");
};

export const renderCommandHelp = (commandPath: string, command: CommandSpec): string => {
  const subcommandRows = (command.subcommands ?? []).map((subcommand) => ({
    label: usageLabel(subcommand.name, subcommand),
    description: subcommand.description,
  }));
  const positionalRows = command.positionals.map((positionalSpec) => ({
    label: positionalUsage(positionalSpec),
    description: positionalSpec.description,
  }));
  const flagRows = Object.entries(command.flags).map(([flagName, flag]) => ({
    label: flagUsage(flagName, flag),
    description: flag.description,
  }));
  return [
    `${commandPath} — ${command.description}`,
    "",
    `Usage: ${usageLabel(commandPath, command)}`,
    ...sectionLines("Commands", subcommandRows),
    ...sectionLines("Arguments", positionalRows),
    ...sectionLines("Options", flagRows),
  ].join("\n");
};
