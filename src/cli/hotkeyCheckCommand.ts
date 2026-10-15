import { Command, Options } from "@effect/cli";
import { Effect, Schema } from "effect";

import { loadKeyboard } from "../dictation/keyboard.js";
import * as TerminalUI from "./TerminalUI.js";

class NoShiftSeen extends Schema.TaggedError<NoShiftSeen>()("NoShiftSeen", {}) {
  get message(): string {
    return "No Shift press seen. Allow Input Monitoring for your terminal in System Settings → Privacy & Security.";
  }
}

const secondsOption = Options.integer("seconds").pipe(
  Options.withDefault(8),
  Options.withDescription("How long to watch Shift"),
);

export const hotkeyCheckCommand = Command.make("hotkey-check", { seconds: secondsOption }, (args) =>
  Effect.gen(function* () {
    const keyboard = yield* loadKeyboard;
    yield* TerminalUI.step(`Hold Shift… (watching for ${String(args.seconds)} s)`);
    const deadline = Date.now() + args.seconds * 1_000;
    let wasDown = false;
    let sawDown = false;
    while (Date.now() < deadline) {
      const isDown = keyboard.shiftDown();
      const isPressed = isDown && !wasDown;
      const isReleased = !isDown && wasDown;
      if (isPressed) {
        yield* TerminalUI.text("SHIFT DOWN");
      }

      if (isReleased) {
        yield* TerminalUI.text("SHIFT UP");
      }

      sawDown = sawDown || isDown;
      wasDown = isDown;
      yield* Effect.sleep("20 millis");
    }

    if (!sawDown) {
      return yield* new NoShiftSeen();
    }

    yield* TerminalUI.success("Shift detection works.");
  }),
).pipe(Command.withDescription("Print Shift presses for a few seconds, to check that voxkey can see the keyboard"));
