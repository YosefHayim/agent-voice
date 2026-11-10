export const isErrorWithCode = (error: unknown, code: string): boolean => {
  const isNotObject = typeof error !== "object" || error === null;
  if (isNotObject) {
    return false;
  }

  return "code" in error && error.code === code;
};
