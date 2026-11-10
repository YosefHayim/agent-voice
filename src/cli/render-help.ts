import type { CommandSpec, FlagSpec, PositionalSpec } from "./command-spec.js";

interface HelpLine {
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

const listTableLines = (storedList: ReadonlyArray<HelpLine>): ReadonlyArray<string> => {
  const labelWidth = Math.max(...storedList.map((helpLine) => helpLine.label.length));
  return storedList.map((helpLine) => `${INDENT}${helpLine.label.padEnd(labelWidth)}  ${helpLine.description}`);
};

const listSectionLines = (title: string, storedList: ReadonlyArray<HelpLine>): ReadonlyArray<string> => {
  const isEmptySection = storedList.length === 0;
  if (isEmptySection) {
    return [];
  }

  return ["", `${title}:`, ...listTableLines(storedList)];
};

export const createRootHelp = (commands: ReadonlyArray<CommandSpec>): string => {
  const storedCommandList = commands.map((command) => ({
    label: readUsageLabel(command.name, command),
    description: command.description,
  }));
  return [
    "agent-voice · Hold Shift to dictate into any text field and hear coding-agent replies read aloud.",
    "",
    "Usage: agent-voice <command> [options]",
    ...listSectionLines("Commands", storedCommandList),
    "",
    "Run agent-voice <command> --help for the options of one command.",
  ].join("\n");
};

export const createCommandHelp = (commandPath: string, command: CommandSpec): string => {
  const storedSubcommandList = (command.subcommands ?? []).map((subcommand) => ({
    label: readUsageLabel(subcommand.name, subcommand),
    description: subcommand.description,
  }));
  const storedPositionalList = command.positionals.map((positionalSpec) => ({
    label: readPositionalUsage(positionalSpec),
    description: positionalSpec.description,
  }));
  const storedFlagList = Object.entries(command.flags).map(([flagName, flag]) => ({
    label: flagUsage(flagName, flag),
    description: flag.description,
  }));
  return [
    `${commandPath} — ${command.description}`,
    "",
    `Usage: ${readUsageLabel(commandPath, command)}`,
    ...listSectionLines("Commands", storedSubcommandList),
    ...listSectionLines("Arguments", storedPositionalList),
    ...listSectionLines("Options", storedFlagList),
  ].join("\n");
};
