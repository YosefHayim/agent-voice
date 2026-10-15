import { Prompt } from "@effect/cli";
import { Terminal } from "@effect/platform";
import { Console, Effect } from "effect";

const display = (text: string) => Effect.flatMap(Terminal.Terminal, (terminal) => terminal.display(text));

const writeLine = (message: string) => display(`${message}\n`);

export const isInteractiveTerminal = Effect.flatMap(Terminal.Terminal, (terminal) => terminal.isTTY);

export const intro = (title: string) => writeLine(`\n  voxkey · ${title}\n`);

export const outro = (message: string) => writeLine(`\n  ${message}\n`);

export const step = (message: string) => writeLine(`  → ${message}`);

export const success = (message: string) => writeLine(`  ✓ ${message}`);

export const warn = (message: string) => writeLine(`  ! ${message}`);

export const fail = (message: string) => writeLine(`  ✗ ${message}`);

export const detail = (message: string) => writeLine(`  · ${message}`);

export const json = (document: unknown) => {
  const documentText = JSON.stringify(document);
  return writeLine(documentText);
};

// Exactly this text and a newline, for output another program reads (a refined prompt, rendered speech).
export const text = (message: string) => writeLine(message);

const underline = (title: string): string => {
  const width = Math.min(title.length, 40);
  return "─".repeat(width);
};

export const note = (title: string, message: string) =>
  Effect.gen(function* () {
    yield* writeLine(`\n  ${title}`);
    yield* writeLine(`  ${underline(title)}`);
    for (const line of message.split("\n")) {
      yield* writeLine(`  ${line}`);
    }
  });

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

// stderr, so `--json` output on stdout stays one parseable document.
export const showError = (error: unknown) => {
  const message = errorText(error);
  return Console.error(`  ✗ ${message}`);
};

// Prompt.select has no initial choice, so the initial one is listed first and highlighted.
export const selectOne = <Value>(input: {
  readonly message: string;
  readonly choices: ReadonlyArray<{ title: string; value: Value; description?: string }>;
  readonly initial?: Value;
}) => {
  const initial = input.choices.filter((choice) => choice.value === input.initial);
  const others = input.choices.filter((choice) => choice.value !== input.initial);
  const prompt = Prompt.select({ message: input.message, choices: [...initial, ...others] });
  return Prompt.run(prompt);
};
