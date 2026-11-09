import type { CommandSpec } from "./command-spec.js";
import { configCommand } from "./config-command.js";
import { devinCommand } from "./devin-command.js";
import { doctorCommand } from "./doctor-command.js";
import { hotkeyCheckCommand } from "./hotkey-check-command.js";
import { offCommand } from "./off-command.js";
import { onCommand } from "./on-command.js";
import { refineCommand } from "./refine-command.js";
import { renderCommand } from "./render-command.js";
import { replyCommand } from "./reply-command.js";
import { resetCommand } from "./reset-command.js";
import { speakCommand } from "./speak-command.js";
import { statusCommand } from "./status-command.js";
import { workerCommand } from "./worker-command.js";

export const commandSpecs: ReadonlyArray<CommandSpec> = [
  onCommand,
  offCommand,
  statusCommand,
  doctorCommand,
  configCommand,
  speakCommand,
  renderCommand,
  refineCommand,
  devinCommand,
  hotkeyCheckCommand,
  resetCommand,
  replyCommand,
  workerCommand,
];
