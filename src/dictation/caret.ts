/**
 * Put text at the caret: key events for dictation-length text (a failed ⌘V would type a bare "v"), the
 * clipboard and ⌘V for long refined prompts, restoring the previous clipboard right after.
 */

import { execFile, spawn } from "node:child_process";

import { Effect, Schema } from "effect";

import { appendDictationLog } from "../workers/workerLog.js";
import type { Keyboard } from "./keyboard.js";

export class CaretError extends Schema.TaggedError<CaretError>()("CaretError", {
  issue: Schema.String,
}) {
  get message(): string {
    return this.issue;
  }
}

/** Above this length the clipboard is faster than key events. */
const CLIPBOARD_CHARACTERS = 800;

export const readClipboard: Effect.Effect<string, CaretError> = Effect.async((resume) => {
  execFile("pbpaste", { encoding: "utf8" }, (error, stdout) =>
    resume(
      error === null ? Effect.succeed(stdout) : Effect.fail(new CaretError({ issue: `pbpaste: ${error.message}` })),
    ),
  );
});

export const writeClipboard = (text: string): Effect.Effect<void, CaretError> =>
  Effect.async((resume) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) => resume(Effect.fail(new CaretError({ issue: `pbcopy: ${error.message}` }))));
    child.on("exit", (code) =>
      resume(code === 0 ? Effect.void : Effect.fail(new CaretError({ issue: `pbcopy exited ${String(code)}` }))),
    );
    child.stdin.end(text);
  });

/** Wait (up to `maxMs`) for the dictation Shift to be up, releasing it once, so it cannot corrupt typed text. */
const waitForShiftUp = (keyboard: Keyboard, maxMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + maxMs;
    keyboard.releaseShift();
    while (keyboard.shiftDown() && Date.now() < deadline) {
      yield* Effect.sleep("10 millis");
    }
    // A small settle so the focused app accepts key events after the hotkey release.
    yield* Effect.sleep("25 millis");
  });

const commandVWithSystemEvents: Effect.Effect<void, CaretError> = Effect.async((resume) => {
  execFile("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down'], (error) =>
    resume(error === null ? Effect.void : Effect.fail(new CaretError({ issue: error.message }))),
  );
});

// Confirm the pasteboard holds the text before ⌘V: a raced pbcopy would otherwise paste something else.
const pasteText = (keyboard: Keyboard, text: string) =>
  Effect.gen(function* () {
    const previous = yield* Effect.either(readClipboard);
    yield* writeClipboard(text);
    if ((yield* readClipboard) !== text) {
      return yield* new CaretError({ issue: "the clipboard did not take the text" });
    }

    yield* commandVWithSystemEvents.pipe(Effect.orElse(() => Effect.sync(() => keyboard.pressCommandV())));
    if (previous._tag === "Right") {
      // Restore only while the clipboard still holds the pasted text: anything copied meanwhile stays.
      yield* Effect.forkDaemon(
        Effect.sleep("400 millis").pipe(
          Effect.zipRight(readClipboard),
          Effect.flatMap((current) => (current === text ? writeClipboard(previous.right) : Effect.void)),
          Effect.ignore,
        ),
      );
    }
  });

/** Type `text` into the focused field, then press Enter when asked. */
export const typeAtCaret = (request: {
  readonly keyboard: Keyboard;
  readonly text: string;
  readonly pressEnter: boolean;
}): Effect.Effect<void, CaretError> =>
  Effect.gen(function* () {
    if (request.text === "") {
      return;
    }

    yield* waitForShiftUp(request.keyboard, 900);
    const length = [...request.text].length;
    if (length <= CLIPBOARD_CHARACTERS) {
      request.keyboard.typeUnicode(request.text);
      appendDictationLog(`type_path chars=${String(length)} keys`);
    } else {
      yield* pasteText(request.keyboard, request.text).pipe(
        Effect.tap(() => Effect.sync(() => appendDictationLog(`type_path chars=${String(length)} clipboard`))),
        Effect.orElse(() => Effect.sync(() => request.keyboard.typeUnicode(request.text))),
      );
    }
    if (request.pressEnter) {
      yield* waitForShiftUp(request.keyboard, 400);
      request.keyboard.pressReturn();
    }
  });
