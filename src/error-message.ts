// The message of a thrown Error, or the text of any other thrown value.
export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
