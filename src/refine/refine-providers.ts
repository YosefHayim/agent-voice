import { randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";
import { readStatusFolder } from "#src/settings/agent-voice-home.js";
import { makePrivateFolder, readFileIfReadable, removeFileIfExists } from "#src/storage/state-files.js";
import {
  type CliRun,
  findFirstCli,
  listNonBlankLines,
  readCliFailureReason,
  readCliReply,
  runCli,
} from "./agent-cli.js";
import type { ProviderId } from "./provider-models.js";
import {
  checkRefinedPrompt,
  createRefinePrompt,
  describeRefineReplyRejection,
  isCliHelpScreen,
  isFailedModelReply,
  readReplyFromDocument,
} from "./refine-reply.js";

export interface RefineAttempt {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: string;
  // The prompt as dictated or copied, before refining.
  readonly draft: string;
}

type Invocation = { readonly executable: string; readonly args: ReadonlyArray<string> };

const AGENT_TIMEOUT_MS = 180_000;
const CODEX_TIMEOUT_MS = 120_000;
const OLLAMA_GENERATE_URL = "http://127.0.0.1:11434/api/generate";
const OLLAMA_EMPTY_DETAIL = "ollama returned empty refine output";
const OPENCODE_HELP_DETAIL =
  "opencode printed its CLI help instead of a reply (invoke as: opencode run -m provider/model --format json <prompt>)";

// Throws the detail, which the caller prefixes with the provider and model it tried.
const failAttempt = (detail: string): never => {
  throw new Error(detail.slice(0, 2_000));
};

const requireCli = (names: ReadonlyArray<string>): string => {
  const installed = findFirstCli(names);

  const isNotInstalled = installed === null;
  if (isNotInstalled) {
    return failAttempt(`${names.join(" or ")} not found on PATH`);
  }

  return installed.path;
};

const readTimeout = (provider: ProviderId): number => {
  const isProviderCodex = provider === "codex";
  if (isProviderCodex) {
    return CODEX_TIMEOUT_MS;
  }

  return AGENT_TIMEOUT_MS;
};

const run = (attempt: RefineAttempt, invocation: Invocation, signal: AbortSignal): Promise<CliRun> =>
  runCli({ ...invocation, timeoutMs: readTimeout(attempt.provider), signal });

// A CLI that exits non-zero failed, whatever it printed: its stderr is a diagnostic, never a refined prompt.
const requireCleanExit = (attempt: RefineAttempt, cliRun: CliRun): CliRun => {
  const isCleanExit = cliRun.exitCode === 0;
  if (isCleanExit) {
    return cliRun;
  }

  const failureReason = readCliFailureReason(cliRun) || `${attempt.provider} exited with ${String(cliRun.exitCode)}`;
  return failAttempt(failureReason);
};

const runSucceeded = async (attempt: RefineAttempt, invocation: Invocation, signal: AbortSignal): Promise<CliRun> => {
  const cliRun = await run(attempt, invocation, signal);
  return requireCleanExit(attempt, cliRun);
};

// An empty value leaves its flag out.
const listOptionalFlag = (flag: string, field: string): ReadonlyArray<string> => {
  const isFieldEmpty = field === "";
  if (isFieldEmpty) {
    return [];
  }

  return [flag, field];
};

// "default" or the CLI's own name means its configured model, so no model flag is passed.
export const readNamedModel = (model: string, defaults: ReadonlyArray<string>): string => {
  const trimmed = model.trim();

  const isTrimmedInDefaults = defaults.includes(trimmed);
  if (isTrimmedInDefaults) {
    return "";
  }

  return trimmed;
};

const readDocumentOrPlainReply = (cliRun: CliRun): string =>
  readReplyFromDocument(cliRun.stdout) || readCliReply(cliRun);

const readCodexEffortSetting = (effort: string): string => {
  const isEffortEmpty = effort === "";
  if (isEffortEmpty) {
    return "";
  }

  return `model_reasoning_effort="${effort}"`;
};

const listCodexArgumentList = (attempt: RefineAttempt, replyFile: string): ReadonlyArray<string> => {
  const effortSetting = readCodexEffortSetting(attempt.effort);
  const prompt = createRefinePrompt(attempt.draft);
  return [
    "exec",
    ...listOptionalFlag("-c", effortSetting),
    "-m",
    attempt.model,
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--color",
    "never",
    "-o",
    replyFile,
    prompt,
  ];
};

const readReplyFile = (replyFile: string): string => {
  const string = readFileIfReadable(replyFile) ?? "";
  return string.trim();
};

const readCodexPrintoutReply = (cliRun: CliRun): string => {
  const cliRunReply = readDocumentOrPlainReply(cliRun);
  const replyLines = listNonBlankLines(cliRunReply).filter(
    (line) => !/^(?:ERROR:|warning:)/u.test(line) && !line.includes("invalid_request_error"),
  );
  return replyLines.at(-1) ?? "";
};

// Trust codex's -o file: for a bad model codex prints an ERROR JSON on stdout with a non-zero exit.
const readCodexLastReply = (cliRun: CliRun, fileReply: string): string => {
  const isFailedRun = cliRun.exitCode !== 0 && fileReply === "";
  if (isFailedRun) {
    const failureReason = readCliFailureReason(cliRun) || "codex exec failed";
    return failAttempt(failureReason);
  }

  const reply = fileReply || readCodexPrintoutReply(cliRun);

  const isReplyEmpty = reply === "";
  if (isReplyEmpty) {
    const cliRunReply = readCliReply(cliRun);
    return failAttempt(cliRunReply || "codex refine returned empty output");
  }

  return reply;
};

const readCodexReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  // Codex writes the refined prompt here with its own file mode, so the folder keeps it private.
  const folder = readStatusFolder("prompts");
  makePrivateFolder(folder);
  const replyFile = path.join(folder, `codex-${randomUUID()}.txt`);
  const argumentList = listCodexArgumentList(attempt, replyFile);
  try {
    const cliRun = await run(attempt, { executable, args: argumentList }, signal);
    const fileReply = readReplyFile(replyFile);
    return readCodexLastReply(cliRun, fileReply);
  } finally {
    removeFileIfExists(replyFile);
  }
};

const readGrokReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const prompt = createRefinePrompt(attempt.draft);
  const model = attempt.model.trim();
  const argumentList = [
    "-p",
    prompt,
    "--output-format",
    "plain",
    "--always-approve",
    "--max-turns",
    "1",
    "--no-subagents",
    "--disable-web-search",
    ...listOptionalFlag("-m", model),
    ...listOptionalFlag("--reasoning-effort", attempt.effort),
  ];
  const cliRun = await runSucceeded(attempt, { executable, args: argumentList }, signal);
  return readCliReply(cliRun);
};

// Ollama answers with JSON; a body that is not that JSON has no reply, the same as an empty one.
const ollamaGenerateSchema = z.object({ response: z.string().optional() });

const parseOllamaFields = (ollamaLine: string): z.infer<typeof ollamaGenerateSchema> | null => {
  try {
    const parsed: unknown = JSON.parse(ollamaLine);
    const checked = ollamaGenerateSchema.safeParse(parsed);

    const isCheckFailed = !checked.success;
    if (isCheckFailed) {
      return null;
    }

    return checked.data;
  } catch {
    return null;
  }
};

const readGeneratedReply = (ollamaLine: string): string => {
  const parsedFields = parseOllamaFields(ollamaLine);
  return (parsedFields?.response ?? "").trim();
};

const askOllamaOverHttp = async (attempt: RefineAttempt, model: string): Promise<string> => {
  try {
    const httpReply = await fetch(OLLAMA_GENERATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: createRefinePrompt(attempt.draft), stream: false }),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    const ollamaLine = await httpReply.text();
    return readGeneratedReply(ollamaLine);
  } catch (error) {
    return failAttempt(`ollama HTTP refine failed: ${String(error)}`);
  }
};

const readOllamaReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const model = attempt.model.trim() || "llama3.2";
  const prompt = createRefinePrompt(attempt.draft);
  const cliRun = await run(attempt, { executable, args: ["run", model, prompt] }, signal);

  const cliReply = readCliReply(cliRun);

  const isCliReplyNotEmpty = cliReply !== "";
  if (isCliReplyNotEmpty) {
    return cliReply;
  }

  // Only a failed `ollama run` that printed nothing gets a second try over ollama's local HTTP API.
  const isCleanExit = cliRun.exitCode === 0;
  if (isCleanExit) {
    return failAttempt(OLLAMA_EMPTY_DETAIL);
  }

  const httpReply = await askOllamaOverHttp(attempt, model);

  const isHttpReplyEmpty = httpReply === "";
  if (isHttpReplyEmpty) {
    return failAttempt(OLLAMA_EMPTY_DETAIL);
  }

  return httpReply;
};

const OPENCODE_VARIANTS = new Map([
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["max", "max"],
  ["xhigh", "max"],
]);

// `opencode run [options] <message>`: the message is positional (`--prompt` would print help with exit 0).
const readOpencodeReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const effort = attempt.effort.toLowerCase();
  const variant = OPENCODE_VARIANTS.get(effort) ?? "";
  const model = readNamedModel(attempt.model, ["default", "opencode", "auto"]);
  const prompt = createRefinePrompt(attempt.draft);
  const argumentList = [
    "run",
    "--format",
    "json",
    ...listOptionalFlag("-m", model),
    ...listOptionalFlag("--variant", variant),
    prompt,
  ];
  const cliRun = await runSucceeded(attempt, { executable, args: argumentList }, signal);

  const reply = readDocumentOrPlainReply(cliRun);

  const isCliHelpReply = isCliHelpScreen(reply);
  if (isCliHelpReply) {
    return failAttempt(OPENCODE_HELP_DETAIL);
  }

  return reply;
};

const readClaudeReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const prompt = createRefinePrompt(attempt.draft);
  const model = attempt.model.trim();
  const argumentList = ["-p", prompt, "--output-format", "text", ...listOptionalFlag("--model", model)];
  const cliRun = await runSucceeded(attempt, { executable, args: argumentList }, signal);
  return readDocumentOrPlainReply(cliRun);
};

// agy accepts low/medium/high only.
const AGY_EFFORTS = new Map([
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "high"],
  ["max", "high"],
]);

const GEMINI_DEFAULT_MODELS = ["default", "gemini", "auto"];

// -p and --print take the next argument as the prompt.
const listAgyArgumentList = (attempt: RefineAttempt): ReadonlyArray<string> => {
  const model = readNamedModel(attempt.model, GEMINI_DEFAULT_MODELS);
  const effort = attempt.effort.toLowerCase();
  const agyEffort = AGY_EFFORTS.get(effort) ?? "";
  const prompt = createRefinePrompt(attempt.draft);
  return [
    "--output-format",
    "json",
    ...listOptionalFlag("--model", model),
    ...listOptionalFlag("--effort", agyEffort),
    "--print",
    prompt,
  ];
};

const listGeminiArgumentList = (attempt: RefineAttempt): ReadonlyArray<string> => {
  const model = readNamedModel(attempt.model, GEMINI_DEFAULT_MODELS);
  const prompt = createRefinePrompt(attempt.draft);
  return ["-p", prompt, ...listOptionalFlag("-m", model)];
};

// The gemini provider runs Google's gemini, or Antigravity's agy when only agy is installed.
const listGeminiFamilyArgumentList = (attempt: RefineAttempt, executable: string): ReadonlyArray<string> => {
  const cliName = path.basename(executable).toLowerCase();

  const isAgy = cliName === "agy";
  if (isAgy) {
    return listAgyArgumentList(attempt);
  }

  return listGeminiArgumentList(attempt);
};

const readGeminiReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const argumentList = listGeminiFamilyArgumentList(attempt, executable);
  const cliRun = await runSucceeded(attempt, { executable, args: argumentList }, signal);
  return readDocumentOrPlainReply(cliRun);
};

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "off", "max"];

const readPiThinking = (effort: string): string => {
  const isEffortEmpty = effort === "";
  if (isEffortEmpty) {
    return "";
  }

  const isKnownThinkingLevel = PI_THINKING_LEVELS.includes(effort);
  if (isKnownThinkingLevel) {
    return effort;
  }

  return "low";
};

// pi (pi-coding-agent) print mode: no tools, no saved session; the model may carry a ":thinking" suffix.
const readPiReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const effort = attempt.effort.toLowerCase();
  const thinking = readPiThinking(effort);
  const model = readNamedModel(attempt.model, ["default", "pi-latest"]);
  const prompt = createRefinePrompt(attempt.draft);
  const argumentList = [
    "--no-tools",
    "--no-session",
    "--mode",
    "text",
    ...listOptionalFlag("--model", model),
    ...listOptionalFlag("--thinking", thinking),
    "-p",
    prompt,
  ];
  const cliRun = await runSucceeded(attempt, { executable, args: argumentList }, signal);
  return readDocumentOrPlainReply(cliRun);
};

type ProviderCall = {
  readonly binaries: ReadonlyArray<string>;
  readonly reply: (attempt: RefineAttempt, executable: string, signal: AbortSignal) => Promise<string>;
};

const PROVIDER_CALLS: Readonly<Record<ProviderId, ProviderCall>> = {
  codex: { binaries: ["codex"], reply: readCodexReply },
  grok: { binaries: ["grok", "agent"], reply: readGrokReply },
  ollama: { binaries: ["ollama"], reply: readOllamaReply },
  opencode: { binaries: ["opencode"], reply: readOpencodeReply },
  claude: { binaries: ["claude"], reply: readClaudeReply },
  gemini: { binaries: ["gemini", "agy"], reply: readGeminiReply },
  pi: { binaries: ["pi", "pie"], reply: readPiReply },
};

const readProviderReply = (attempt: RefineAttempt, signal: AbortSignal): Promise<string> => {
  const providerCall = PROVIDER_CALLS[attempt.provider];
  const executable = requireCli(providerCall.binaries);
  return providerCall.reply(attempt, executable, signal);
};

const readCheckedReply = (attempt: RefineAttempt, reply: string): string => {
  const isFailedPrintout = isFailedModelReply(reply);
  if (isFailedPrintout) {
    return failAttempt(reply || `${attempt.provider} refine failed`);
  }

  const checked = checkRefinedPrompt({ draft: attempt.draft, refined: reply });

  const isRejected = checked.status === "rejected";
  if (isRejected) {
    return failAttempt(describeRefineReplyRejection(checked.rejection));
  }

  return checked.prompt;
};

// One provider and model with no rotation: the checked, refined prompt, or why it failed.
export const refineWithProvider = async (attempt: RefineAttempt, signal: AbortSignal): Promise<string> => {
  const reply = await readProviderReply(attempt, signal);
  return readCheckedReply(attempt, reply);
};
