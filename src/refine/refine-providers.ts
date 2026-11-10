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

const AGY_PROVIDER_ID = "agy";

const GEMINI_PROVIDER_ID = "gemini";

const TEXT_OUTPUT_VALUE = "text";

const JSON_OUTPUT_VALUE = "json";

const AUTO_VALUE = "auto";

const OPENCODE_PROVIDER_ID = "opencode";

const DEFAULT_MODEL_NAME = "default";

const XHIGH_EFFORT = "xhigh";

const MAX_EFFORT = "max";

const HIGH_EFFORT = "high";

const MEDIUM_EFFORT = "medium";

const LOW_EFFORT = "low";

const MINIMAL_EFFORT = "minimal";

const RUN_COMMAND = "run";

const MODEL_LONG_FLAG = "--model";

const OUTPUT_FORMAT_FLAG = "--output-format";

const PROMPT_SHORT_FLAG = "-p";

const MODEL_SHORT_FLAG = "-m";

const CODEX_PROVIDER_ID = "codex";

export interface RefineAttempt {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: string;
  readonly draft: string;
}

type Invocation = { readonly executable: string; readonly args: ReadonlyArray<string> };

const AGENT_TIMEOUT_MS = 180_000;
const CODEX_TIMEOUT_MS = 120_000;
const OLLAMA_EMPTY_DETAIL = "ollama returned empty refine output";

// Throws the detail, which the caller prefixes with the provider and model it tried.
const failAttempt = (detail: string): never => {
  const errorDetailCharacters = 2_000;

  throw new Error(detail.slice(0, errorDetailCharacters));
};

const requireCli = (names: ReadonlyArray<string>): string => {
  const installed = findFirstCli(names);

  const isNotInstalled = installed == null;
  if (isNotInstalled) {
    return failAttempt(`${names.join(" or ")} not found on PATH`);
  }

  return installed.path;
};

const readTimeout = (provider: ProviderId): number => {
  const isProviderCodex = provider === CODEX_PROVIDER_ID;
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
    MODEL_SHORT_FLAG,
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
    PROMPT_SHORT_FLAG,
    prompt,
    OUTPUT_FORMAT_FLAG,
    "plain",
    "--always-approve",
    "--max-turns",
    "1",
    "--no-subagents",
    "--disable-web-search",
    ...listOptionalFlag(MODEL_SHORT_FLAG, model),
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
    const httpReply = await fetch("http://127.0.0.1:11434/api/generate", {
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
  const cliRun = await run(attempt, { executable, args: [RUN_COMMAND, model, prompt] }, signal);

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
  [MINIMAL_EFFORT, MINIMAL_EFFORT],
  [LOW_EFFORT, LOW_EFFORT],
  [MEDIUM_EFFORT, MEDIUM_EFFORT],
  [HIGH_EFFORT, HIGH_EFFORT],
  [MAX_EFFORT, MAX_EFFORT],
  [XHIGH_EFFORT, MAX_EFFORT],
]);

// `opencode run [options] <message>`: the message is positional (`--prompt` would print help with exit 0).
const readOpencodeReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const effort = attempt.effort.toLowerCase();
  const variant = OPENCODE_VARIANTS.get(effort) ?? "";
  const model = readNamedModel(attempt.model, [DEFAULT_MODEL_NAME, OPENCODE_PROVIDER_ID, AUTO_VALUE]);
  const prompt = createRefinePrompt(attempt.draft);
  const argumentList = [
    RUN_COMMAND,
    "--format",
    JSON_OUTPUT_VALUE,
    ...listOptionalFlag(MODEL_SHORT_FLAG, model),
    ...listOptionalFlag("--variant", variant),
    prompt,
  ];
  const cliRun = await runSucceeded(attempt, { executable, args: argumentList }, signal);

  const reply = readDocumentOrPlainReply(cliRun);

  const isCliHelpReply = isCliHelpScreen(reply);
  if (isCliHelpReply) {
    return failAttempt(
      "opencode printed its CLI help instead of a reply (invoke as: opencode run -m provider/model --format json <prompt>)",
    );
  }

  return reply;
};

const readClaudeReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const prompt = createRefinePrompt(attempt.draft);
  const model = attempt.model.trim();
  const argumentList = [
    PROMPT_SHORT_FLAG,
    prompt,
    OUTPUT_FORMAT_FLAG,
    TEXT_OUTPUT_VALUE,
    ...listOptionalFlag(MODEL_LONG_FLAG, model),
  ];
  const cliRun = await runSucceeded(attempt, { executable, args: argumentList }, signal);
  return readDocumentOrPlainReply(cliRun);
};

// agy accepts low/medium/high only.
const AGY_EFFORTS = new Map([
  [MINIMAL_EFFORT, LOW_EFFORT],
  [LOW_EFFORT, LOW_EFFORT],
  [MEDIUM_EFFORT, MEDIUM_EFFORT],
  [HIGH_EFFORT, HIGH_EFFORT],
  [XHIGH_EFFORT, HIGH_EFFORT],
  [MAX_EFFORT, HIGH_EFFORT],
]);

const GEMINI_DEFAULT_MODELS = [DEFAULT_MODEL_NAME, GEMINI_PROVIDER_ID, AUTO_VALUE];

// -p and --print take the next argument as the prompt.
const listAgyArgumentList = (attempt: RefineAttempt): ReadonlyArray<string> => {
  const model = readNamedModel(attempt.model, GEMINI_DEFAULT_MODELS);
  const effort = attempt.effort.toLowerCase();
  const agyEffort = AGY_EFFORTS.get(effort) ?? "";
  const prompt = createRefinePrompt(attempt.draft);
  return [
    OUTPUT_FORMAT_FLAG,
    JSON_OUTPUT_VALUE,
    ...listOptionalFlag(MODEL_LONG_FLAG, model),
    ...listOptionalFlag("--effort", agyEffort),
    "--print",
    prompt,
  ];
};

const listGeminiArgumentList = (attempt: RefineAttempt): ReadonlyArray<string> => {
  const model = readNamedModel(attempt.model, GEMINI_DEFAULT_MODELS);
  const prompt = createRefinePrompt(attempt.draft);
  return [PROMPT_SHORT_FLAG, prompt, ...listOptionalFlag(MODEL_SHORT_FLAG, model)];
};

// The gemini provider runs Google's gemini, or Antigravity's agy when only agy is installed.
const listGeminiFamilyArgumentList = (attempt: RefineAttempt, executable: string): ReadonlyArray<string> => {
  const cliName = path.basename(executable).toLowerCase();

  const isAgy = cliName === AGY_PROVIDER_ID;
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

const readPiThinking = (effort: string): string => {
  const isEffortEmpty = effort === "";
  if (isEffortEmpty) {
    return "";
  }

  const isKnownThinkingLevel = [
    MINIMAL_EFFORT,
    LOW_EFFORT,
    MEDIUM_EFFORT,
    HIGH_EFFORT,
    XHIGH_EFFORT,
    "off",
    MAX_EFFORT,
  ].includes(effort);
  if (isKnownThinkingLevel) {
    return effort;
  }

  return LOW_EFFORT;
};

// pi (pi-coding-agent) print mode: no tools, no saved session; the model may carry a ":thinking" suffix.
const readPiReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const effort = attempt.effort.toLowerCase();
  const thinking = readPiThinking(effort);
  const model = readNamedModel(attempt.model, [DEFAULT_MODEL_NAME, "pi-latest"]);
  const prompt = createRefinePrompt(attempt.draft);
  const argumentList = [
    "--no-tools",
    "--no-session",
    "--mode",
    TEXT_OUTPUT_VALUE,
    ...listOptionalFlag(MODEL_LONG_FLAG, model),
    ...listOptionalFlag("--thinking", thinking),
    PROMPT_SHORT_FLAG,
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
  codex: { binaries: [CODEX_PROVIDER_ID], reply: readCodexReply },
  grok: { binaries: ["grok", "agent"], reply: readGrokReply },
  ollama: { binaries: ["ollama"], reply: readOllamaReply },
  opencode: { binaries: [OPENCODE_PROVIDER_ID], reply: readOpencodeReply },
  claude: { binaries: ["claude"], reply: readClaudeReply },
  gemini: { binaries: [GEMINI_PROVIDER_ID, AGY_PROVIDER_ID], reply: readGeminiReply },
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

export const refineWithProvider = async (attempt: RefineAttempt, signal: AbortSignal): Promise<string> => {
  const reply = await readProviderReply(attempt, signal);
  return readCheckedReply(attempt, reply);
};
