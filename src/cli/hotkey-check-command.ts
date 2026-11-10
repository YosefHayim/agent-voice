import { holdKeyLabels } from "#src/dictation/hold-key.js";
import { loadKeyboard } from "#src/dictation/keyboard.js";
import { sleep } from "#src/sleep.js";
import { type CommandSpec, readStringFlag } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

const pollMilliseconds = 20;
const millisecondsPerSecond = 1_000;

export const hotkeyCheckCommand: CommandSpec = {
  name: "hotkey-check",
  description: "Print configured hold-key presses for a few seconds, to check that agent-voice can see the keyboard",
  flags: {
    seconds: { kind: "integer", description: "How long to watch the configured hold key (default 8)" },
  },
  positionals: [],
  run: async (parsedCommand) => {
    const defaultWatchSeconds = 8;
    const secondsWord = readStringFlag(parsedCommand, "seconds");
    const isSecondsWordMissing = secondsWord == null;
    const watchSeconds = isSecondsWordMissing ? defaultWatchSeconds : Number(secondsWord);
    const keyboard = await loadKeyboard();
    const label = holdKeyLabels[keyboard.holdKey];
    TerminalUI.printStep(`Hold ${label}… (watching for ${String(watchSeconds)} s)`);

    const deadline = Date.now() + watchSeconds * millisecondsPerSecond;
    let wasDown = false;
    let sawDown = false;
    while (Date.now() < deadline) {
      const isDown = keyboard.holdDown();
      const isPressed = isDown && !wasDown;
      const isReleased = !isDown && wasDown;

      if (isPressed) {
        TerminalUI.printLine(`${label} DOWN`);
      }

      if (isReleased) {
        TerminalUI.printLine(`${label} UP`);
      }

      sawDown = sawDown || isDown;
      wasDown = isDown;
      await sleep(pollMilliseconds);
    }

    const isDownUnseen = !sawDown;
    if (isDownUnseen) {
      throw new Error(
        "No hold-key press seen. Allow Input Monitoring for your terminal in System Settings → Privacy & Security.",
      );
    }

    TerminalUI.printSuccess(`${label} detection works.`);
    return 0;
  },
};
