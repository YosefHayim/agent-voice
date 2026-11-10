// Exit codes: 0 ok, 1 failed, 2 bad usage. Commands return one; only main.ts sets the process exit code.
export type ExitCode = 0 | 1 | 2;

export type ParsedFlags = Readonly<Record<string, string | boolean | ReadonlyArray<string | boolean> | undefined>>;

export interface ParsedCommand {
  readonly flags: ParsedFlags;
  readonly positionals: Readonly<Record<string, string | undefined>>;
  readonly extraArguments: ReadonlyArray<string>;
}

export interface FlagSpec {
  readonly kind: "boolean" | "text" | "integer";
  readonly description: string;
  readonly choices?: ReadonlyArray<string>;
}

export interface PositionalSpec {
  readonly name: string;
  readonly description: string;
  readonly isRequired: boolean;
  readonly choices?: ReadonlyArray<string>;
}

export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly flags: Readonly<Record<string, FlagSpec>>;
  readonly positionals: ReadonlyArray<PositionalSpec>;
  readonly subcommands?: ReadonlyArray<CommandSpec>;
  // Passes every word after the command name to the run function, unparsed (devin).
  readonly isPassthrough?: boolean;
  readonly run?: (parsedCommand: ParsedCommand) => Promise<ExitCode>;
}

export const isFlagOn = (parsedCommand: ParsedCommand, flagName: string): boolean =>
  parsedCommand.flags[flagName] === true;

export const readStringFlag = (parsedCommand: ParsedCommand, flagName: string): string | null => {
  const flagWord = parsedCommand.flags[flagName];

  const isNotWordGiven = typeof flagWord !== "string";
  if (isNotWordGiven) {
    return null;
  }

  return flagWord;
};

export const readOptionalPositional = (parsedCommand: ParsedCommand, positionalName: string): string | null =>
  parsedCommand.positionals[positionalName] ?? null;

// The parser already rejects a missing required word, so a missing one here is a bug and fails loudly.
export const readRequiredPositional = (parsedCommand: ParsedCommand, positionalName: string): string => {
  const positionalWord = parsedCommand.positionals[positionalName];

  const isWordMissing = positionalWord == null;
  if (isWordMissing) {
    throw new Error(`Missing ${positionalName}.`);
  }

  return positionalWord;
};
