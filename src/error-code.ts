// True when a Node system error carries this code, such as "ENOENT" for a missing file.
export const isErrorWithCode = (error: unknown, code: string): boolean => {
  const isObject = typeof error === "object" && error !== null;
  if (!isObject) {
    return false;
  }

  return "code" in error && error.code === code;
};
