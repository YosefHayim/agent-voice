export const sleep = (milliseconds: number): Promise<void> =>
  new Promise<void>((wake) => {
    setTimeout(wake, milliseconds);
  });
