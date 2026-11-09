import { parseArgs } from "node:util";

import { describeError } from "#src/error-message.js";
import { commandSpecs } from "./command-list.js";
import type { CommandSpec, ExitCode, FlagSpec, ParsedCommand, ParsedFlags, PositionalSpec } from "./command-spec.js";
import { renderCommandHelp, renderRootHelp } from "./render-help.js";

export type CommandRoute =
  | { readonly kind: "help"; readonly helpMessage: string }
  | { readonly kind: "version" }
  | { readonly kind: "hook"; readonly hookArguments: ReadonlyArray<string> }
  | { readonly kind: "usage"; readonly message: string }
  | {
      readonly kind: "run";
      readonly run: (parsedCommand: ParsedCommand) => Promise<ExitCode>;
      readonly parsedCommand: ParsedCommand;
    };

const rootHelpRoute = (): CommandRoute => ({ kind: "help", helpMessage: renderRootHelp(commandSpecs) });

const commandHelpRoute = (commandPath: string, command: CommandSpec): CommandRoute => ({
  kind: "help",
  helpMessage: renderCommandHelp(commandPath, command),
});

const parseTypeOf = (flag: FlagSpec): "boolean" | "string" => {
  const isBooleanFlag = flag.kind === "boolean";
  if (isBooleanFlag) {
    return "boolean";
  }

  return "string";
};

const toParseOptions = (flags: Readonly<Record<string, FlagSpec>>) => {
  const optionEntries = Object.entries(flags).map(
    ([flagName, flag]) => [flagName, { type: parseTypeOf(flag) }] as const,
  );
  return Object.fromEntries(optionEntries);
};

const checkFlagWord = (flagName: string, flag: FlagSpec, flagWord: string): void => {
  const isOutsideChoices = flag.choices != null && !flag.choices.includes(flagWord);
  if (isOutsideChoices) {
    throw new Error(`Invalid value "${flagWord}" for --${flagName}. Use one of: ${String(flag.choices?.join(", "))}.`);
  }

  const isNotWholeNumber = flag.kind === "integer" && !/^\d+$/u.test(flagWord);
  if (isNotWholeNumber) {
    throw new Error(`--${flagName} needs a whole number.`);
  }
};

const checkFlagWords = (flags: Readonly<Record<string, FlagSpec>>, parsedFlags: ParsedFlags): void => {
  for (const [flagName, flag] of Object.entries(flags)) {
    const flagWord = parsedFlags[flagName];
    const isWordGiven = typeof flagWord === "string";
    if (isWordGiven) {
      checkFlagWord(flagName, flag, flagWord);
    }
  }
};

const checkPositionalWords = (
  positionalSpecs: ReadonlyArray<PositionalSpec>,
  positionalWords: ReadonlyArray<string>,
): void => {
  for (const [index, positionalSpec] of positionalSpecs.entries()) {
    const positionalWord = positionalWords[index];
    const isWordMissing = positionalWord == null;
    const isRequiredWordMissing = isWordMissing && positionalSpec.isRequired;
    if (isRequiredWordMissing) {
      throw new Error(`Missing ${positionalSpec.name}.`);
    }

    const isOutsideChoices =
      positionalWord != null && positionalSpec.choices != null && !positionalSpec.choices.includes(positionalWord);
    if (isOutsideChoices) {
      throw new Error(
        `Invalid ${positionalSpec.name} "${positionalWord}". Use one of: ${String(positionalSpec.choices?.join(", "))}.`,
      );
    }
  }

  const isTooManyWords = positionalWords.length > positionalSpecs.length;
  if (isTooManyWords) {
    throw new Error(`Unexpected argument "${String(positionalWords[positionalSpecs.length])}".`);
  }
};

const bindPositionals = (
  positionalSpecs: ReadonlyArray<PositionalSpec>,
  positionalWords: ReadonlyArray<string>,
): Readonly<Record<string, string | undefined>> =>
  Object.fromEntries(positionalSpecs.map((positionalSpec, index) => [positionalSpec.name, positionalWords[index]]));

const dropLeadingSeparator = (restWords: ReadonlyArray<string>): ReadonlyArray<string> => {
  const isSeparatorFirst = restWords[0] === "--";
  if (isSeparatorFirst) {
    return restWords.slice(1);
  }

  return restWords;
};

const routeLeaf = (request: {
  readonly command: CommandSpec;
  readonly commandPath: string;
  readonly restWords: ReadonlyArray<string>;
}): CommandRoute => {
  const { command, commandPath, restWords } = request;
  const run = command.run;
  const isRunMissing = run == null;
  if (isRunMissing) {
    return commandHelpRoute(commandPath, command);
  }

  const isPassthrough = command.isPassthrough === true;
  if (isPassthrough) {
    const extraArguments = dropLeadingSeparator(restWords);
    return { kind: "run", run, parsedCommand: { flags: {}, positionals: {}, extraArguments } };
  }

  const isHelpRequest = restWords.includes("--help") || restWords.includes("-h");
  if (isHelpRequest) {
    return commandHelpRoute(commandPath, command);
  }

  const parsedArguments = parseArgs({
    args: [...restWords],
    options: toParseOptions(command.flags),
    allowPositionals: true,
    strict: true,
  });
  checkFlagWords(command.flags, parsedArguments.values);
  checkPositionalWords(command.positionals, parsedArguments.positionals);
  const positionals = bindPositionals(command.positionals, parsedArguments.positionals);
  return { kind: "run", run, parsedCommand: { flags: parsedArguments.values, positionals, extraArguments: [] } };
};

// Walks the words down the command tree: a group (config) has subcommands, a leaf has flags and a run function.
const routeWithin = (request: {
  readonly commandWords: ReadonlyArray<string>;
  readonly group: CommandSpec | null;
  readonly commandPath: string;
}): CommandRoute => {
  const [wordName, ...restWords] = request.commandWords;
  const isNoWordLeft = wordName == null;
  const isHelpWord = wordName === "--help" || wordName === "-h";
  if (isNoWordLeft || isHelpWord) {
    return request.group == null ? rootHelpRoute() : commandHelpRoute(request.commandPath, request.group);
  }

  const commands = request.group == null ? commandSpecs : (request.group.subcommands ?? []);
  const command = commands.find((candidate) => candidate.name === wordName);
  const isUnknownCommand = command == null;
  if (isUnknownCommand) {
    throw new Error(`Unknown command "${wordName}". Run ${request.commandPath} --help.`);
  }

  const commandPath = `${request.commandPath} ${command.name}`;
  const isGroup = command.subcommands != null;
  if (isGroup) {
    return routeWithin({ commandWords: restWords, group: command, commandPath });
  }

  return routeLeaf({ command, commandPath, restWords });
};

const routeCommandWords = (commandWords: ReadonlyArray<string>): CommandRoute => {
  const [firstWord] = commandWords;
  const isNoWordGiven = firstWord == null;
  const isHelpWord = firstWord === "--help" || firstWord === "-h";
  if (isNoWordGiven || isHelpWord) {
    return rootHelpRoute();
  }

  const isVersionWord = firstWord === "--version";
  if (isVersionWord) {
    return { kind: "version" };
  }

  // Claude Code's Stop hook runs `reply`; it skips the parser so an unexpected flag never exits 2 and blocks the agent.
  const isHookWord = firstWord === "reply";
  if (isHookWord) {
    return { kind: "hook", hookArguments: commandWords.slice(1) };
  }

  return routeWithin({ commandWords, group: null, commandPath: "agent-voice" });
};

// The one place a usage problem becomes a message; main.ts turns it into exit code 2.
export const parseCommandLine = (commandWords: ReadonlyArray<string>): CommandRoute => {
  try {
    return routeCommandWords(commandWords);
  } catch (usageProblem) {
    return { kind: "usage", message: describeError(usageProblem) };
  }
};
