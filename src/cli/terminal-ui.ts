import { createInterface } from "node:readline/promises";

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

const underline = (title: string): string => {
  const width = Math.min(title.length, 40);
  return "─".repeat(width);
};

export const printNote = (title: string, message: string): void => {
  console.log(`\n  ${title}`);
  console.log(`  ${underline(title)}`);

  for (const line of message.split("\n")) {
    console.log(`  ${line}`);
  }
};

// stderr, so `--json` output on stdout stays one parseable jsonDocument.
export const printError = (error: unknown): void => {
  console.error(`  ✗ ${describeError(error)}`);
};

const descriptionNote = (description: string | undefined): string => {
  if (description == null) {
    return "";
  }

  return ` (${description})`;
};

const choiceFromAnswer = <Picked>(
  orderedChoices: ReadonlyArray<ChoiceOption<Picked>>,
  answer: string,
): Picked | null => {
  const trimmedAnswer = answer.trim();
  const isEnterOnly = trimmedAnswer === "";
  if (isEnterOnly) {
    return orderedChoices[0]?.pick ?? null;
  }

  const chosenNumber = Number(trimmedAnswer);
  const chosenChoice = orderedChoices[chosenNumber - 1];
  return chosenChoice?.pick ?? null;
};

// One numbered question. The initial choice is listed first, so Enter takes it. Any answer that is not a listed number cancels (null).
export const askChoice = async <Picked>(request: {
  readonly message: string;
  readonly choices: ReadonlyArray<ChoiceOption<Picked>>;
  readonly initial?: Picked;
}): Promise<Picked | null> => {
  const initialChoices = request.choices.filter((choice) => choice.pick === request.initial);
  const otherChoices = request.choices.filter((choice) => choice.pick !== request.initial);
  const orderedChoices = [...initialChoices, ...otherChoices];

  console.log(`\n  ${request.message}`);
  for (const [index, choice] of orderedChoices.entries()) {
    console.log(`  ${String(index + 1)}. ${choice.title}${descriptionNote(choice.description)}`);
  }

  const answerReader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await answerReader.question("  Number [1]: ");
    return choiceFromAnswer(orderedChoices, answer);
  } finally {
    answerReader.close();
  }
};
