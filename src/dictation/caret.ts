// Dictation-length text goes in as key events, because a failed Command-V would type a bare "v".
// A long refined prompt goes through the clipboard, and the previous clipboard comes back right after.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { sleep } from "#src/sleep.js";
import { appendDictationLog } from "#src/workers/worker-log.js";
import type { Keyboard } from "./keyboard.js";

// Above this length the clipboard is faster than key events.
const CLIPBOARD_CHARACTERS = 800;

const runFile = promisify(execFile);

export const readClipboard = async (): Promise<string> => {
  try {
    const output = await runFile("pbpaste", { encoding: "utf8" });
    return output.stdout;
  } catch (error) {
    throw new Error(`pbpaste: ${String(error)}`, { cause: error });
  }
};

export const writeClipboard = (text: string): Promise<void> =>
  new Promise<void>((finishWrite, failWrite) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) => failWrite(new Error(`pbcopy: ${error.message}`, { cause: error })));
    child.on("exit", (code) => {
      const isCopyOk = code === 0;
      if (isCopyOk) {
        finishWrite();
        return;
      }

      failWrite(new Error(`pbcopy exited ${String(code)}`));
    });
    child.stdin.end(text);
  });

// Release the selected modifier before typing so it cannot alter the text.
const waitForHoldUp = async (keyboard: Keyboard, maxMs: number): Promise<void> => {
  const deadline = Date.now() + maxMs;
  keyboard.releaseHoldKey();
  while (keyboard.holdDown() && Date.now() < deadline) {
    await sleep(10);
  }

  // A small settle so the focused app accepts key events after the hotkey release.
  await sleep(25);
};

// Restores only while the clipboard still holds the pasted text, so anything copied meanwhile stays.
// Runs in the background after the paste, so it logs its own failure instead of throwing.
const restoreClipboard = async (request: { readonly pasted: string; readonly previous: string }): Promise<void> => {
  try {
    await sleep(400);
    const currentClipboard = await readClipboard();
    const isClipboardStillPasted = currentClipboard === request.pasted;
    if (!isClipboardStillPasted) {
      return;
    }

    await writeClipboard(request.previous);
  } catch (error) {
    appendDictationLog(`clipboard restore failed: ${String(error)}`);
  }
};

// System Events can be denied; the posted key event still pastes.
const pressCommandV = async (keyboard: Keyboard): Promise<void> => {
  try {
    await runFile("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
  } catch {
    keyboard.pressCommandV();
  }
};

// The pasteboard is read back before Command-V, because a raced pbcopy would paste something else.
const pasteText = async (keyboard: Keyboard, text: string): Promise<void> => {
  const previous = await readPreviousClipboard();
  await writeClipboard(text);
  const copied = await readClipboard();
  const isClipboardCopyFailing = copied !== text;
  if (isClipboardCopyFailing) {
    throw new Error("the clipboard did not take the text");
  }

  await pressCommandV(keyboard);
  const isPreviousClipboardUnknown = previous === null;
  if (isPreviousClipboardUnknown) {
    return;
  }

  // Not awaited: the restore waits 400 milliseconds, and the paste should not.
  void restoreClipboard({ pasted: text, previous });
};

// A clipboard that cannot be read is not restored afterwards.
const readPreviousClipboard = async (): Promise<string | null> => {
  try {
    return await readClipboard();
  } catch {
    return null;
  }
};

const putText = async (keyboard: Keyboard, text: string): Promise<void> => {
  const length = [...text].length;
  const isShortEnoughToType = length <= CLIPBOARD_CHARACTERS;
  if (isShortEnoughToType) {
    keyboard.typeUnicode(text);
    appendDictationLog(`type_path chars=${String(length)} keys`);
    return;
  }

  try {
    await pasteText(keyboard, text);
    appendDictationLog(`type_path chars=${String(length)} clipboard`);
  } catch (error) {
    appendDictationLog(`type_path chars=${String(length)} paste failed, typing instead: ${String(error)}`);
    keyboard.typeUnicode(text);
  }
};

export const typeAtCaret = async (request: {
  readonly keyboard: Keyboard;
  readonly text: string;
  readonly pressEnter: boolean;
}): Promise<void> => {
  const isThereNoText = request.text === "";
  if (isThereNoText) {
    return;
  }

  await waitForHoldUp(request.keyboard, 900);
  await putText(request.keyboard, request.text);
  if (!request.pressEnter) {
    return;
  }

  await waitForHoldUp(request.keyboard, 400);
  request.keyboard.pressReturn();
};
