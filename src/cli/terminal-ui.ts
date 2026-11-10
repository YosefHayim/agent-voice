import { isCancel, select } from "@clack/prompts";

import { describeError } from "#src/error-message.js";

export interface ChoiceOption<Picked> {
  readonly title: string;
  readonly pick: Picked;
  readonly description?: string;
}

export const isInteractiveTerminal = (): boolean => process.stdin.isTTY === true;

export const printIntro = (title: string): void => {
  console.log(`\n  agent-voice · ${title}\n`);
};

export const printOutro = (message: string): void => {
  console.log(`\n  ${message}\n`);
};

export const printStep = (message: string): void => {
  console.log(`  → ${message}`);
};

export const printSuccess = (message: string): void => {
  console.log(`  ✓ ${message}`);
};

export const printWarning = (message: string): void => {
  console.log(`  ! ${message}`);
};

export const printFailure = (message: string): void => {
  console.log(`  ✗ ${message}`);
};

export const printDetail = (message: string): void => {
  console.log(`  · ${message}`);
};

// Exactly this text and a newline, for output another program reads (a refined prompt, rendered speech).
export const printLine = (message: string): void => {
  console.log(message);
};

export const printDocument = (jsonDocument: unknown): void => {
  console.log(JSON.stringify(jsonDocument));
};

const readUnderline = (title: string): string => {
  const width = Math.min(title.length, 40);
  return "─".repeat(width);
};

export const printNote = (title: string, message: string): void => {
  console.log(`\n  ${title}`);
  console.log(`  ${readUnderline(title)}`);

  for (const line of message.split("\n")) {
    console.log(`  ${line}`);
  }
};

// stderr, so `--json` output on stdout stays one parseable jsonDocument.
export const printError = (error: unknown): void => {
  console.error(`  ✗ ${describeError(error)}`);
};

// One arrow-key question. Null when the user cancels (Escape or Ctrl+C).
export const askChoice = async <Picked>(request: {
  readonly message: string;
  readonly choices: ReadonlyArray<ChoiceOption<Picked>>;
  readonly initial?: Picked;
}): Promise<Picked | null> => {
  const pickedChoice = await select({
    message: request.message,
    options: request.choices.map((choice) => ({ value: choice.pick, label: choice.title, hint: choice.description })),
    initialValue: request.initial,
  });

  const isPickCancelled = isCancel(pickedChoice);
  if (isPickCancelled) {
    return null;
  }

  return pickedChoice;
};
