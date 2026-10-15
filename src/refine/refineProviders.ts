import { randomUUID } from "node:crypto";
import path from "node:path";

import { Effect, Either, Option, Schema } from "effect";

import { makePrivateFolder, readTextIfReadable, removeIfPresent } from "../files/stateFiles.js";
import { stateFolder } from "../settings/agentVoiceHome.js";
import { type CliRun, cliFailureText, cliOutputText, findCli, nonBlankLines, runCli } from "./agentCli.js";
import { type ProviderId, providerIdSchema } from "./providerModels.js";
import {
  checkRefinedPrompt,
  looksLikeCliHelp,
  looksLikeFailedModelOutput,
  refinePromptFor,
  replyTextFromJson,
} from "./refineReply.js";

export class RefineAttemptFailed extends Schema.TaggedError<RefineAttemptFailed>()("RefineAttemptFailed", {
  provider: Schema.String,
  model: Schema.String,
  detail: Schema.String,
}) {
  get message(): string {
    return `${this.provider}/${this.model}: ${this.detail}`;
  }
}

const refineAttemptSchema = Schema.Struct({
  provider: providerIdSchema,
  model: Schema.String,
  effort: Schema.String,
  draft: Schema.String.annotations({ description: "The prompt as dictated or copied, before refining." }),
});

export type RefineAttempt = Schema.Schema.Type<typeof refineAttemptSchema>;

type Invocation = { readonly executable: string; readonly args: ReadonlyArray<string> };

const AGENT_TIMEOUT_MS = 180_000;
const CODEX_TIMEOUT_MS = 120_000;
const OLLAMA_GENERATE_URL = "http://127.0.0.1:11434/api/generate";
const OLLAMA_EMPTY_DETAIL = "ollama returned empty refine output";
const OPENCODE_HELP_DETAIL =
  "opencode printed its CLI help instead of a reply (invoke as: opencode run -m provider/model --format json <prompt>)";

const attemptFailure = (attempt: RefineAttempt, detail: string): RefineAttemptFailed =>
  new RefineAttemptFailed({ provider: attempt.provider, model: attempt.model, detail: detail.slice(0, 2_000) });

const failAttempt = (attempt: RefineAttempt, detail: string): Effect.Effect<never, RefineAttemptFailed> => {
  const failure = attemptFailure(attempt, detail);
  return Effect.fail(failure);
};

const requireCli = (
  attempt: RefineAttempt,
  names: ReadonlyArray<string>,
): Effect.Effect<string, RefineAttemptFailed> => {
  const installed = names.map(findCli);
  const executable = Option.firstSomeOf(installed);
  if (Option.isNone(executable)) {
    return failAttempt(attempt, `${names.join(" or ")} not found on PATH`);
  }

  return Effect.succeed(executable.value);
};

const timeoutFor = (provider: ProviderId): number => {
  if (provider === "codex") {
    return CODEX_TIMEOUT_MS;
  }

  return AGENT_TIMEOUT_MS;
};

const run = (attempt: RefineAttempt, invocation: Invocation): Effect.Effect<CliRun, RefineAttemptFailed> => {
  const timeoutMs = timeoutFor(attempt.provider);
  return runCli({ ...invocation, timeoutMs }).pipe(Effect.mapError((error) => attemptFailure(attempt, error.message)));
};

// A CLI that exits non-zero failed, whatever it printed: its stderr is a diagnostic, never a refined prompt.
const requireCleanExit = (attempt: RefineAttempt, cliRun: CliRun): Effect.Effect<CliRun, RefineAttemptFailed> => {
  if (cliRun.exitCode === 0) {
    return Effect.succeed(cliRun);
  }

  const failureText = cliFailureText(cliRun) || `${attempt.provider} exited with ${String(cliRun.exitCode)}`;
  return failAttempt(attempt, failureText);
};

const runSucceeded = (attempt: RefineAttempt, invocation: Invocation): Effect.Effect<CliRun, RefineAttemptFailed> =>
  run(attempt, invocation).pipe(Effect.flatMap((cliRun) => requireCleanExit(attempt, cliRun)));

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
  const prompt = refinePromptFor(attempt.draft);
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
  const text = readTextIfReadable(replyFile).pipe(Option.getOrElse(() => ""));
  return text.trim();
};

const codexOutputReply = (cliRun: CliRun): string => {
  const outputText = jsonOrPlainReply(cliRun);
  const replyLines = nonBlankLines(outputText).filter(
    (line) => !/^(?:ERROR:|warning:)/u.test(line) && !line.includes("invalid_request_error"),
  );
  return replyLines.at(-1) || "";
};

// Trust codex's -o file: for a bad model codex prints an ERROR JSON on stdout with a non-zero exit.
const codexReply = (attempt: RefineAttempt, executable: string) =>
  Effect.gen(function* () {
    // Codex writes the refined prompt here with its own file mode, so the folder keeps it private.
    const folder = stateFolder("prompts");
    makePrivateFolder(folder);
    const replyFile = path.join(folder, `codex-${randomUUID()}.txt`);
    const args = codexArgs(attempt, replyFile);
    const removeReplyFile = Effect.sync(() => removeIfPresent(replyFile));
    const { cliRun, fileReply } = yield* run(attempt, { executable, args }).pipe(
      Effect.map((finishedRun) => ({ cliRun: finishedRun, fileReply: fileReplyText(replyFile) })),
      Effect.ensuring(removeReplyFile),
    );
    const isFailedRun = cliRun.exitCode !== 0 && fileReply === "";
    if (isFailedRun) {
      const failureText = cliFailureText(cliRun) || "codex exec failed";
      return yield* failAttempt(attempt, failureText);
    }

    const reply = fileReply || codexOutputReply(cliRun);
    if (reply === "") {
      const outputText = cliOutputText(cliRun);
      return yield* failAttempt(attempt, outputText || "codex refine returned empty output");
    }

    return reply;
  });

const grokReply = (attempt: RefineAttempt, executable: string) => {
  const prompt = refinePromptFor(attempt.draft);
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
  return runSucceeded(attempt, { executable, args }).pipe(Effect.map(cliOutputText));
};

const decodeOllamaGenerate = Schema.decodeUnknownOption(
  Schema.parseJson(Schema.Struct({ response: Schema.optional(Schema.String) })),
);

const generatedText = (text: string): string =>
  decodeOllamaGenerate(text).pipe(
    Option.map((generated) => (generated.response || "").trim()),
    Option.getOrElse(() => ""),
  );

const ollamaOverHttp = (attempt: RefineAttempt, model: string) =>
  Effect.tryPromise({
    try: async () => {
      const httpReply = await fetch(OLLAMA_GENERATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: refinePromptFor(attempt.draft), stream: false }),
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
      return await httpReply.text();
    },
    catch: (error) => attemptFailure(attempt, `ollama HTTP refine failed: ${String(error)}`),
  }).pipe(Effect.map(generatedText));

const ollamaReply = (attempt: RefineAttempt, executable: string) =>
  Effect.gen(function* () {
    const model = attempt.model.trim() || "llama3.2";
    const prompt = refinePromptFor(attempt.draft);
    const cliRun = yield* run(attempt, { executable, args: ["run", model, prompt] });
    const cliReply = cliOutputText(cliRun);
    if (cliReply !== "") {
      return cliReply;
    }

    // Only a failed `ollama run` that printed nothing gets a second try over ollama's local HTTP API.
    const isCleanExit = cliRun.exitCode === 0;
    if (isCleanExit) {
      return yield* failAttempt(attempt, OLLAMA_EMPTY_DETAIL);
    }

    const httpReply = yield* ollamaOverHttp(attempt, model);
    if (httpReply === "") {
      return yield* failAttempt(attempt, OLLAMA_EMPTY_DETAIL);
    }

    return httpReply;
  });

const OPENCODE_VARIANTS = new Map([
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["max", "max"],
  ["xhigh", "max"],
]);

// `opencode run [options] <message>`: the message is positional (`--prompt` would print help with exit 0).
const opencodeReply = (attempt: RefineAttempt, executable: string) =>
  Effect.gen(function* () {
    const effort = attempt.effort.toLowerCase();
    const variant = OPENCODE_VARIANTS.get(effort) || "";
    const model = namedModel(attempt.model, ["default", "opencode", "auto"]);
    const prompt = refinePromptFor(attempt.draft);
    const args = [
      "run",
      "--format",
      "json",
      ...optionalFlag("-m", model),
      ...optionalFlag("--variant", variant),
      prompt,
    ];
    const cliRun = yield* runSucceeded(attempt, { executable, args });
    const reply = jsonOrPlainReply(cliRun);
    if (looksLikeCliHelp(reply)) {
      return yield* failAttempt(attempt, OPENCODE_HELP_DETAIL);
    }

    return reply;
  });

const claudeReply = (attempt: RefineAttempt, executable: string) => {
  const prompt = refinePromptFor(attempt.draft);
  const model = attempt.model.trim();
  const args = ["-p", prompt, "--output-format", "text", ...optionalFlag("--model", model)];
  return runSucceeded(attempt, { executable, args }).pipe(Effect.map(jsonOrPlainReply));
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
  const agyEffort = AGY_EFFORTS.get(effort) || "";
  const prompt = refinePromptFor(attempt.draft);
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
  const prompt = refinePromptFor(attempt.draft);
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

const geminiReply = (attempt: RefineAttempt, executable: string) => {
  const args = geminiFamilyArgs(attempt, executable);
  return runSucceeded(attempt, { executable, args }).pipe(Effect.map(jsonOrPlainReply));
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
const piReply = (attempt: RefineAttempt, executable: string) => {
  const effort = attempt.effort.toLowerCase();
  const thinking = piThinking(effort);
  const model = namedModel(attempt.model, ["default", "pi-latest"]);
  const prompt = refinePromptFor(attempt.draft);
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
  return runSucceeded(attempt, { executable, args }).pipe(Effect.map(jsonOrPlainReply));
};

type ProviderCall = {
  readonly binaries: ReadonlyArray<string>;
  readonly reply: (attempt: RefineAttempt, executable: string) => Effect.Effect<string, RefineAttemptFailed>;
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

const providerReply = (attempt: RefineAttempt): Effect.Effect<string, RefineAttemptFailed> => {
  const providerCall = PROVIDER_CALLS[attempt.provider];
  return requireCli(attempt, providerCall.binaries).pipe(
    Effect.flatMap((executable) => providerCall.reply(attempt, executable)),
  );
};

const checkedReply = (attempt: RefineAttempt, reply: string): Effect.Effect<string, RefineAttemptFailed> => {
  if (looksLikeFailedModelOutput(reply)) {
    return failAttempt(attempt, reply || `${attempt.provider} refine failed`);
  }

  const checked = checkRefinedPrompt({ draft: attempt.draft, refined: reply });
  if (Either.isLeft(checked)) {
    return failAttempt(attempt, checked.left.message);
  }

  return Effect.succeed(checked.right);
};

// One provider and model with no rotation: the checked, refined prompt, or why it failed.
export const refineWithProvider = (attempt: RefineAttempt): Effect.Effect<string, RefineAttemptFailed> =>
  providerReply(attempt).pipe(Effect.flatMap((reply) => checkedReply(attempt, reply)));
