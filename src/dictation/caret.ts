// Dictation-length text goes in as key events, because a failed Command-V would type a bare "v".
// A long refined prompt goes through the clipboard, and the previous clipboard comes back right after.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { Effect, Either, Schema } from "effect";

import { appendDictationLog } from "../workers/workerLog.js";
import type { Keyboard } from "./keyboard.js";

export class CaretError extends Schema.TaggedError<CaretError>()("CaretError", {
  issue: Schema.String,
}) {
  get message(): string {
    return this.issue;
  }
}

// Above this length the clipboard is faster than key events.
const CLIPBOARD_CHARACTERS = 800;

const runFile = promisify(execFile);

export const readClipboard: Effect.Effect<string, CaretError> = Effect.tryPromise({
  try: async () => {
    const output = await runFile("pbpaste", { encoding: "utf8" });
    return output.stdout;
  },
  catch: (error) => new CaretError({ issue: `pbpaste: ${String(error)}` }),
});

export const writeClipboard = (text: string): Effect.Effect<void, CaretError> =>
  Effect.async((resume) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) => resume(new CaretError({ issue: `pbcopy: ${error.message}` })));
    child.on("exit", (code) => {
      if (code === 0) {
        resume(Effect.void);
        return;
      }

      resume(new CaretError({ issue: `pbcopy exited ${String(code)}` }));
    });
    child.stdin.end(text);
  });

const commandVWithSystemEvents: Effect.Effect<void, CaretError> = Effect.tryPromise({
  try: () => runFile("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']),
  catch: (error) => new CaretError({ issue: String(error) }),
}).pipe(Effect.asVoid);

// Releases the dictation Shift once and waits for it to read up, so it cannot capitalize the typed text.
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

// Restores only while the clipboard still holds the pasted text, so anything copied meanwhile stays.
const restoreClipboard = (request: { readonly pasted: string; readonly previous: string }) =>
  Effect.gen(function* () {
    yield* Effect.sleep("400 millis");
    const current = yield* readClipboard;
    if (current !== request.pasted) {
      return;
    }

    yield* writeClipboard(request.previous);
  }).pipe(Effect.ignore);

// The pasteboard is read back before Command-V, because a raced pbcopy would paste something else.
const pasteText = (keyboard: Keyboard, text: string) =>
  Effect.gen(function* () {
    const previous = yield* Effect.either(readClipboard);
    yield* writeClipboard(text);
    const copied = yield* readClipboard;
    if (copied !== text) {
      return yield* new CaretError({ issue: "the clipboard did not take the text" });
    }

    yield* commandVWithSystemEvents.pipe(Effect.orElse(() => Effect.sync(() => keyboard.pressCommandV())));
    if (Either.isLeft(previous)) {
      return;
    }

    yield* restoreClipboard({ pasted: text, previous: previous.right }).pipe(Effect.forkDaemon);
  });

const putText = (keyboard: Keyboard, text: string) =>
  Effect.gen(function* () {
    const length = [...text].length;
    if (length <= CLIPBOARD_CHARACTERS) {
      keyboard.typeUnicode(text);
      appendDictationLog(`type_path chars=${String(length)} keys`);
      return;
    }

    yield* pasteText(keyboard, text).pipe(
      Effect.tap(() => Effect.sync(() => appendDictationLog(`type_path chars=${String(length)} clipboard`))),
      Effect.orElse(() => Effect.sync(() => keyboard.typeUnicode(text))),
    );
  });

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
    yield* putText(request.keyboard, request.text);
    if (!request.pressEnter) {
      return;
    }

    yield* waitForShiftUp(request.keyboard, 400);
    request.keyboard.pressReturn();
  });
