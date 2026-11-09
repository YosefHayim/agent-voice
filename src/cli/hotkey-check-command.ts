import { Command, Options } from "@effect/cli";
import { Effect, Schema } from "effect";

import { holdKeyLabels } from "../dictation/hold-key.js";
import { loadKeyboard } from "../dictation/keyboard.js";
import * as TerminalUI from "./terminal-ui.js";

class NoHoldSeen extends Schema.TaggedError<NoHoldSeen>()("NoHoldSeen", {}) {
  get message(): string {
    return "No hold-key press seen. Allow Input Monitoring for your terminal in System Settings → Privacy & Security.";
  }
}

const secondsOption = Options.integer("seconds").pipe(
  Options.withDefault(8),
  Options.withDescription("How long to watch the configured hold key"),
);

export const hotkeyCheckCommand = Command.make("hotkey-check", { seconds: secondsOption }, (args) =>
  Effect.gen(function* () {
    const keyboard = yield* loadKeyboard;
    const label = holdKeyLabels[keyboard.holdKey];
    yield* TerminalUI.step(`Hold ${label}… (watching for ${String(args.seconds)} s)`);
    const deadline = Date.now() + args.seconds * 1_000;
    let wasDown = false;
    let sawDown = false;
    while (Date.now() < deadline) {
      const isDown = keyboard.holdDown();
      const isPressed = isDown && !wasDown;
      const isReleased = !isDown && wasDown;
      if (isPressed) {
        yield* TerminalUI.text(`${label} DOWN`);
      }

      if (isReleased) {
        yield* TerminalUI.text(`${label} UP`);
      }

      sawDown = sawDown || isDown;
      wasDown = isDown;
      yield* Effect.sleep("20 millis");
    }

    if (!sawDown) {
      return yield* new NoHoldSeen();
    }

    yield* TerminalUI.success(`${label} detection works.`);
  }),
).pipe(
  Command.withDescription(
    "Print configured hold-key presses for a few seconds, to check that agent-voice can see the keyboard",
  ),
);
