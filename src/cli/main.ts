#!/usr/bin/env node
import { runReplyHookFromArguments } from "#src/agents/reply-hook.js";
import { agentVoiceVersion } from "./agent-voice-version.js";
import type { ExitCode } from "./command-spec.js";
import { type CommandRoute, parseCommandLine } from "./parse-command-line.js";
import * as TerminalUI from "./terminal-ui.js";

const runRoute = async (route: CommandRoute): Promise<ExitCode> => {
  const isHelpRoute = route.kind === "help";
  if (isHelpRoute) {
    TerminalUI.printLine(route.helpMessage);
    return 0;
  }

  const isVersionRoute = route.kind === "version";
  if (isVersionRoute) {
    TerminalUI.printLine(`agent-voice ${agentVoiceVersion}`);
    return 0;
  }

  const isHookRoute = route.kind === "hook";
  if (isHookRoute) {
    await runReplyHookFromArguments(route.hookArguments);
    return 0;
  }

  const isUsageRoute = route.kind === "usage";
  if (isUsageRoute) {
    TerminalUI.printError(route.message);
    const badUsageExitCode = 2;

    return badUsageExitCode;
  }

  try {
    return await route.run(route.parsedCommand);
  } catch (error) {
    TerminalUI.printError(error);
    return 1;
  }
};

const userArgumentsStart = 2;

process.exitCode = await runRoute(parseCommandLine(process.argv.slice(userArgumentsStart)));
