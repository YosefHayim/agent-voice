import { Schema } from "effect";

// main.ts maps this one failure to exit code 2: the command line was wrong.
export class CliUsageError extends Schema.TaggedError<CliUsageError>()("CliUsageError", {
  issue: Schema.NonEmptyString,
}) {
  get message(): string {
    return this.issue;
  }
}
