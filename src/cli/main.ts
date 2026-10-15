#!/usr/bin/env node
import { CliConfig, Command, ValidationError } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, ParseResult } from "effect";

import { runReplyHookFromArguments } from "../agents/replyHook.js";
import { agentVoiceVersion } from "./agentVoiceVersion.js";
import { CliUsageError } from "./cliUsageError.js";
import { configCommand } from "./configCommand.js";
import { devinCommand } from "./devinCommand.js";
import { doctorCommand } from "./doctorCommand.js";
import { hotkeyCheckCommand } from "./hotkeyCheckCommand.js";
import { offCommand } from "./offCommand.js";
import { onCommand } from "./onCommand.js";
import { refineCommand } from "./refineCommand.js";
import { renderCommand } from "./renderCommand.js";
import { replyCommand } from "./replyCommand.js";
import { resetCommand } from "./resetCommand.js";
import { speakCommand } from "./speakCommand.js";
import { statusCommand } from "./statusCommand.js";
import * as TerminalUI from "./TerminalUI.js";
import { workerCommand } from "./workerCommand.js";

const agentVoice = Command.make("agent-voice").pipe(
  Command.withDescription("Hold Shift to dictate into any text field and hear coding-agent replies read aloud."),
  Command.withSubcommands([
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
  ]),
);

const runAgentVoice = Command.run(agentVoice, { name: "agent-voice", version: agentVoiceVersion });

const cliConfig = CliConfig.layer({ showBuiltIns: false });

const exitCodeFor = (error: unknown): number => {
  const isUsageError =
    ValidationError.isValidationError(error) || ParseResult.isParseError(error) || error instanceof CliUsageError;
  if (isUsageError) {
    return 2;
  }

  return 1;
};

// @effect/cli already printed its own validation message; everything else is shown once here.
const reportFailure = (error: unknown) =>
  Effect.gen(function* () {
    const isPrinted = ValidationError.isValidationError(error);
    if (!isPrinted) {
      yield* TerminalUI.showError(error);
    }

    process.exitCode = exitCodeFor(error);
  });

const runCommandLine = (commandLine: ReadonlyArray<string>) =>
  runAgentVoice(commandLine).pipe(
    Effect.catchAll(reportFailure),
    Effect.provide(NodeContext.layer),
    Effect.provide(cliConfig),
  );

// The Stop hook skips the CLI parser: a parser error exits 2, and exit 2 from a Claude Code Stop hook blocks the agent.
const programFor = (commandLine: ReadonlyArray<string>): Effect.Effect<void> => {
  const commandName = commandLine[2];
  if (commandName === "reply") {
    const hookArguments = commandLine.slice(3);
    return runReplyHookFromArguments(hookArguments);
  }

  if (commandName === undefined) {
    return runCommandLine(["node", "agent-voice", "--help"]);
  }

  return runCommandLine(commandLine);
};

const program = programFor(process.argv);

NodeRuntime.runMain(program);
