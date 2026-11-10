// The message of a thrown Error, or the text of any other thrown value.
export const describeError = (error: unknown): string => {
  const isErrorInstance = error instanceof Error;
  return isErrorInstance ? error.message : String(error);
};
