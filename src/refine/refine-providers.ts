import { randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";
import { stateFolder } from "#src/settings/agent-voice-home.js";
import { makePrivateFolder, readTextIfReadable, removeIfPresent } from "#src/storage/state-files.js";
import { type CliRun, cliFailureText, cliOutputText, findFirstCli, nonBlankLines, runCli } from "./agent-cli.js";
import type { ProviderId } from "./provider-models.js";
import {
  checkRefinedPrompt,
  createRefineRequestText,
  describeRefineReplyRejection,
  looksLikeCliHelp,
  looksLikeFailedModelOutput,
  replyTextFromJson,
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

const timeoutFor = (provider: ProviderId): number => {
  if (provider === "codex") {
    return CODEX_TIMEOUT_MS;
  }

  return AGENT_TIMEOUT_MS;
};

const run = (attempt: RefineAttempt, invocation: Invocation, signal: AbortSignal): Promise<CliRun> =>
  runCli({ ...invocation, timeoutMs: timeoutFor(attempt.provider), signal });

// A CLI that exits non-zero failed, whatever it printed: its stderr is a diagnostic, never a refined prompt.
const requireCleanExit = (attempt: RefineAttempt, cliRun: CliRun): CliRun => {
  const isCleanExit = cliRun.exitCode === 0;
  if (isCleanExit) {
    return cliRun;
  }

  const failureText = cliFailureText(cliRun) || `${attempt.provider} exited with ${String(cliRun.exitCode)}`;
  return failAttempt(failureText);
};

const runSucceeded = async (attempt: RefineAttempt, invocation: Invocation, signal: AbortSignal): Promise<CliRun> => {
  const cliRun = await run(attempt, invocation, signal);
  return requireCleanExit(attempt, cliRun);
};

// An empty value leaves its flag out.
const optionalFlag = (flag: string, value: string): ReadonlyArray<string> => {
  if (value === "") {
    return [];
  }

  return [flag, value];
};

// "default" or the CLI's own name means its configured model, so no model flag is passed.
export const namedModel = (model: string, defaults: ReadonlyArray<string>): string => {
  const trimmed = model.trim();
  if (defaults.includes(trimmed)) {
    return "";
  }

  return trimmed;
};

const jsonOrPlainReply = (cliRun: CliRun): string => replyTextFromJson(cliRun.stdout) || cliOutputText(cliRun);

const codexEffortSetting = (effort: string): string => {
  if (effort === "") {
    return "";
  }

  return `model_reasoning_effort="${effort}"`;
};

const codexArgs = (attempt: RefineAttempt, replyFile: string): ReadonlyArray<string> => {
  const effortSetting = codexEffortSetting(attempt.effort);
  const prompt = createRefineRequestText(attempt.draft);
  return [
    "exec",
    ...optionalFlag("-c", effortSetting),
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

const fileReplyText = (replyFile: string): string => {
  const text = readTextIfReadable(replyFile) ?? "";
  return text.trim();
};

const codexOutputReply = (cliRun: CliRun): string => {
  const outputText = jsonOrPlainReply(cliRun);
  const replyLines = nonBlankLines(outputText).filter(
    (line) => !/^(?:ERROR:|warning:)/u.test(line) && !line.includes("invalid_request_error"),
  );
  return replyLines.at(-1) ?? "";
};

// Trust codex's -o file: for a bad model codex prints an ERROR JSON on stdout with a non-zero exit.
const codexFinalReply = (cliRun: CliRun, fileReply: string): string => {
  const isFailedRun = cliRun.exitCode !== 0 && fileReply === "";
  if (isFailedRun) {
    const failureText = cliFailureText(cliRun) || "codex exec failed";
    return failAttempt(failureText);
  }

  const reply = fileReply || codexOutputReply(cliRun);
  const isReplyEmpty = reply === "";
  if (isReplyEmpty) {
    const outputText = cliOutputText(cliRun);
    return failAttempt(outputText || "codex refine returned empty output");
  }

  return reply;
};

const codexReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  // Codex writes the refined prompt here with its own file mode, so the folder keeps it private.
  const folder = stateFolder("prompts");
  makePrivateFolder(folder);
  const replyFile = path.join(folder, `codex-${randomUUID()}.txt`);
  const args = codexArgs(attempt, replyFile);
  try {
    const cliRun = await run(attempt, { executable, args }, signal);
    const fileReply = fileReplyText(replyFile);
    return codexFinalReply(cliRun, fileReply);
  } finally {
    removeIfPresent(replyFile);
  }
};

const grokReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const prompt = createRefineRequestText(attempt.draft);
  const model = attempt.model.trim();
  const args = [
    "-p",
    prompt,
    "--output-format",
    "plain",
    "--always-approve",
    "--max-turns",
    "1",
    "--no-subagents",
    "--disable-web-search",
    ...optionalFlag("-m", model),
    ...optionalFlag("--reasoning-effort", attempt.effort),
  ];
  const cliRun = await runSucceeded(attempt, { executable, args }, signal);
  return cliOutputText(cliRun);
};

// Ollama answers with JSON; a body that is not that JSON has no reply, the same as an empty one.
const ollamaGenerateSchema = z.object({ response: z.string().optional() });

const parseOllamaBody = (bodyText: string): z.infer<typeof ollamaGenerateSchema> | null => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const checked = ollamaGenerateSchema.safeParse(parsed);
    const isChecked = checked.success;
    if (!isChecked) {
      return null;
    }

    return checked.data;
  } catch {
    return null;
  }
};

const generatedText = (bodyText: string): string => {
  const parsedBody = parseOllamaBody(bodyText);
  return (parsedBody?.response ?? "").trim();
};

const ollamaOverHttp = async (attempt: RefineAttempt, model: string): Promise<string> => {
  try {
    const httpReply = await fetch(OLLAMA_GENERATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: createRefineRequestText(attempt.draft), stream: false }),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    const bodyText = await httpReply.text();
    return generatedText(bodyText);
  } catch (error) {
    return failAttempt(`ollama HTTP refine failed: ${String(error)}`);
  }
};

const ollamaReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const model = attempt.model.trim() || "llama3.2";
  const prompt = createRefineRequestText(attempt.draft);
  const cliRun = await run(attempt, { executable, args: ["run", model, prompt] }, signal);
  const cliReply = cliOutputText(cliRun);
  if (cliReply !== "") {
    return cliReply;
  }

  // Only a failed `ollama run` that printed nothing gets a second try over ollama's local HTTP API.
  const isCleanExit = cliRun.exitCode === 0;
  if (isCleanExit) {
    return failAttempt(OLLAMA_EMPTY_DETAIL);
  }

  const httpReply = await ollamaOverHttp(attempt, model);
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
const opencodeReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const effort = attempt.effort.toLowerCase();
  const variant = OPENCODE_VARIANTS.get(effort) ?? "";
  const model = namedModel(attempt.model, ["default", "opencode", "auto"]);
  const prompt = createRefineRequestText(attempt.draft);
  const args = ["run", "--format", "json", ...optionalFlag("-m", model), ...optionalFlag("--variant", variant), prompt];
  const cliRun = await runSucceeded(attempt, { executable, args }, signal);
  const reply = jsonOrPlainReply(cliRun);
  if (looksLikeCliHelp(reply)) {
    return failAttempt(OPENCODE_HELP_DETAIL);
  }

  return reply;
};

const claudeReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const prompt = createRefineRequestText(attempt.draft);
  const model = attempt.model.trim();
  const args = ["-p", prompt, "--output-format", "text", ...optionalFlag("--model", model)];
  const cliRun = await runSucceeded(attempt, { executable, args }, signal);
  return jsonOrPlainReply(cliRun);
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
const agyArgs = (attempt: RefineAttempt): ReadonlyArray<string> => {
  const model = namedModel(attempt.model, GEMINI_DEFAULT_MODELS);
  const effort = attempt.effort.toLowerCase();
  const agyEffort = AGY_EFFORTS.get(effort) ?? "";
  const prompt = createRefineRequestText(attempt.draft);
  return [
    "--output-format",
    "json",
    ...optionalFlag("--model", model),
    ...optionalFlag("--effort", agyEffort),
    "--print",
    prompt,
  ];
};

const geminiArgs = (attempt: RefineAttempt): ReadonlyArray<string> => {
  const model = namedModel(attempt.model, GEMINI_DEFAULT_MODELS);
  const prompt = createRefineRequestText(attempt.draft);
  return ["-p", prompt, ...optionalFlag("-m", model)];
};

// The gemini provider runs Google's gemini, or Antigravity's agy when only agy is installed.
const geminiFamilyArgs = (attempt: RefineAttempt, executable: string): ReadonlyArray<string> => {
  const cliName = path.basename(executable).toLowerCase();
  const isAgy = cliName === "agy";
  if (isAgy) {
    return agyArgs(attempt);
  }

  return geminiArgs(attempt);
};

const geminiReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const args = geminiFamilyArgs(attempt, executable);
  const cliRun = await runSucceeded(attempt, { executable, args }, signal);
  return jsonOrPlainReply(cliRun);
};

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "off", "max"];

const piThinking = (effort: string): string => {
  if (effort === "") {
    return "";
  }

  if (PI_THINKING_LEVELS.includes(effort)) {
    return effort;
  }

  return "low";
};

// pi (pi-coding-agent) print mode: no tools, no saved session; the model may carry a ":thinking" suffix.
const piReply = async (attempt: RefineAttempt, executable: string, signal: AbortSignal): Promise<string> => {
  const effort = attempt.effort.toLowerCase();
  const thinking = piThinking(effort);
  const model = namedModel(attempt.model, ["default", "pi-latest"]);
  const prompt = createRefineRequestText(attempt.draft);
  const args = [
    "--no-tools",
    "--no-session",
    "--mode",
    "text",
    ...optionalFlag("--model", model),
    ...optionalFlag("--thinking", thinking),
    "-p",
    prompt,
  ];
  const cliRun = await runSucceeded(attempt, { executable, args }, signal);
  return jsonOrPlainReply(cliRun);
};

type ProviderCall = {
  readonly binaries: ReadonlyArray<string>;
  readonly reply: (attempt: RefineAttempt, executable: string, signal: AbortSignal) => Promise<string>;
};

const PROVIDER_CALLS: Readonly<Record<ProviderId, ProviderCall>> = {
  codex: { binaries: ["codex"], reply: codexReply },
  grok: { binaries: ["grok", "agent"], reply: grokReply },
  ollama: { binaries: ["ollama"], reply: ollamaReply },
  opencode: { binaries: ["opencode"], reply: opencodeReply },
  claude: { binaries: ["claude"], reply: claudeReply },
  gemini: { binaries: ["gemini", "agy"], reply: geminiReply },
  pi: { binaries: ["pi", "pie"], reply: piReply },
};

const providerReply = (attempt: RefineAttempt, signal: AbortSignal): Promise<string> => {
  const providerCall = PROVIDER_CALLS[attempt.provider];
  const executable = requireCli(providerCall.binaries);
  return providerCall.reply(attempt, executable, signal);
};

const checkedReply = (attempt: RefineAttempt, reply: string): string => {
  if (looksLikeFailedModelOutput(reply)) {
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
  const reply = await providerReply(attempt, signal);
  return checkedReply(attempt, reply);
};
