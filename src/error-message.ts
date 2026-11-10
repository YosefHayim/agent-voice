export const describeError = (error: unknown): string => {
  const isErrorInstance = error instanceof Error;
  return isErrorInstance ? error.message : String(error);
};
