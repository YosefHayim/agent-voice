/** One refine attempt with one agent CLI and one model; every provider's reply goes through the same checks. */

import { randomUUID } from "node:crypto";
import path from "node:path";

import { Effect, Either, Option, Schema } from "effect";
import { makePrivateFolder, readTextIfReadable, removeIfPresent } from "../files/stateFiles.js";
import { stateFolder } from "../settings/voxkeyHome.js";
import { type CliRun, cliFailureText, cliOutputText, findCli, runCli } from "./agentCli.js";
import { providerIdSchema } from "./providerModels.js";
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

export const refineAttemptSchema = Schema.Struct({
  provider: providerIdSchema,
  model: Schema.String,
  effort: Schema.String,
  draft: Schema.String.annotations({ description: "The prompt as dictated or copied, before refining." }),
});

export type RefineAttempt = Schema.Schema.Type<typeof refineAttemptSchema>;

const AGENT_TIMEOUT_MS = 180_000;
const CODEX_TIMEOUT_MS = 120_000;

const fail = (attempt: RefineAttempt, detail: string) =>
  new RefineAttemptFailed({ provider: attempt.provider, model: attempt.model, detail: detail.slice(0, 2_000) });

const requireCli = (attempt: RefineAttempt, names: ReadonlyArray<string>) =>
  Option.match(Option.firstSomeOf(names.map(findCli)), {
    onNone: () => Effect.fail(fail(attempt, `${names.join(" or ")} not found on PATH`)),
    onSome: (found) => Effect.succeed(found),
  });

const run = (
  attempt: RefineAttempt,
  invocation: { readonly executable: string; readonly args: ReadonlyArray<string> },
) =>
  Effect.mapError(
    runCli({
      ...invocation,
      timeoutMs: attempt.provider === "codex" ? CODEX_TIMEOUT_MS : AGENT_TIMEOUT_MS,
    }),
    (error) => fail(attempt, error.message),
  );

// A CLI that exits non-zero failed, whatever it printed: its stderr is a diagnostic, never a refined prompt.
const runSucceeded = (
  attempt: RefineAttempt,
  invocation: { readonly executable: string; readonly args: ReadonlyArray<string> },
) =>
  Effect.flatMap(run(attempt, invocation), (cliRun) =>
    cliRun.exitCode === 0
      ? Effect.succeed(cliRun)
      : Effect.fail(
          fail(attempt, cliFailureText(cliRun) || `${attempt.provider} exited with ${String(cliRun.exitCode)}`),
        ),
  );

const isNamedModel = (model: string, defaults: ReadonlyArray<string>) =>
  model.trim() !== "" && !defaults.includes(model.trim());

// Trust codex's -o file: for a bad model codex prints an ERROR JSON on stdout with a non-zero exit.
const codexReply = (attempt: RefineAttempt, executable: string) =>
  Effect.gen(function* () {
    // Codex writes the refined prompt here with its own file mode, so the folder keeps it private.
    const folder = stateFolder("prompts");
    makePrivateFolder(folder);
    const replyFile = path.join(folder, `codex-${randomUUID()}.txt`);
    const effort = attempt.effort === "" ? [] : ["-c", `model_reasoning_effort="${attempt.effort}"`];
    const execution = yield* Effect.ensuring(
      run(attempt, {
        executable,
        args: [
          "exec",
          ...effort,
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
          refinePromptFor(attempt.draft),
        ],
      }).pipe(
        Effect.map((cliRun) => ({
          cliRun,
          fileReply: Option.getOrElse(readTextIfReadable(replyFile), () => "").trim(),
        })),
      ),
      Effect.sync(() => removeIfPresent(replyFile)),
    );
    const detail = cliOutputText(execution.cliRun);
    if (execution.cliRun.exitCode !== 0 && execution.fileReply === "") {
      return yield* Effect.fail(fail(attempt, cliFailureText(execution.cliRun) || "codex exec failed"));
    }

    const fallbackLines = (replyTextFromJson(execution.cliRun.stdout) || detail)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^(?:ERROR:|warning:)/u.test(line) && !line.includes("invalid_request_error"));
    const reply = execution.fileReply || fallbackLines.at(-1) || "";
    return reply === "" ? yield* Effect.fail(fail(attempt, detail || "codex refine returned empty output")) : reply;
  });

const grokReply = (attempt: RefineAttempt, executable: string) =>
  Effect.map(
    runSucceeded(attempt, {
      executable,
      args: [
        "-p",
        refinePromptFor(attempt.draft),
        "--output-format",
        "plain",
        "--always-approve",
        "--max-turns",
        "1",
        "--no-subagents",
        "--disable-web-search",
        ...(attempt.model.trim() === "" ? [] : ["-m", attempt.model.trim()]),
        ...(attempt.effort === "" ? [] : ["--reasoning-effort", attempt.effort]),
      ],
    }),
    cliOutputText,
  );

const ollamaGenerateSchema = Schema.parseJson(Schema.Struct({ response: Schema.optional(Schema.String) }));

const ollamaOverHttp = (attempt: RefineAttempt, model: string) =>
  Effect.tryPromise({
    try: async () => {
      const reply = await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: refinePromptFor(attempt.draft), stream: false }),
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
      return await reply.text();
    },
    catch: (error) => fail(attempt, `ollama HTTP refine failed: ${String(error)}`),
  }).pipe(
    Effect.map((text) =>
      Option.getOrElse(
        Option.map(Schema.decodeUnknownOption(ollamaGenerateSchema)(text), (generated) =>
          (generated.response || "").trim(),
        ),
        () => "",
      ),
    ),
  );

const ollamaReply = (attempt: RefineAttempt, executable: string) =>
  Effect.gen(function* () {
    const model = attempt.model.trim() || "llama3.2";
    const cliRun = yield* run(attempt, { executable, args: ["run", model, refinePromptFor(attempt.draft)] });
    const reply = cliOutputText(cliRun) || (cliRun.exitCode === 0 ? "" : yield* ollamaOverHttp(attempt, model));
    return reply === "" ? yield* Effect.fail(fail(attempt, "ollama returned empty refine output")) : reply;
  });

/** `opencode run [options] <message>`: the message is positional (`--prompt` would print help with exit 0). */
const opencodeReply = (attempt: RefineAttempt, executable: string) =>
  Effect.gen(function* () {
    const effort = attempt.effort.toLowerCase();
    const variant = ["minimal", "low", "medium", "high", "max", "xhigh"].includes(effort)
      ? ["--variant", effort === "xhigh" ? "max" : effort]
      : [];
    const cliRun = yield* runSucceeded(attempt, {
      executable,
      args: [
        "run",
        "--format",
        "json",
        ...(isNamedModel(attempt.model, ["default", "opencode", "auto"]) ? ["-m", attempt.model.trim()] : []),
        ...variant,
        refinePromptFor(attempt.draft),
      ],
    });
    const reply = replyTextFromJson(cliRun.stdout) || cliOutputText(cliRun);
    if (looksLikeCliHelp(reply)) {
      return yield* Effect.fail(
        fail(
          attempt,
          "opencode printed its CLI help instead of a reply (invoke as: opencode run -m provider/model --format json <prompt>)",
        ),
      );
    }

    return reply;
  });

const claudeReply = (attempt: RefineAttempt, executable: string) =>
  Effect.map(
    runSucceeded(attempt, {
      executable,
      args: [
        "-p",
        refinePromptFor(attempt.draft),
        "--output-format",
        "text",
        ...(attempt.model.trim() === "" ? [] : ["--model", attempt.model.trim()]),
      ],
    }),
    (cliRun: CliRun) => replyTextFromJson(cliRun.stdout) || cliOutputText(cliRun),
  );

// agy accepts low/medium/high only.
const AGY_EFFORTS: Readonly<Record<string, string>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** Google `gemini`, or Antigravity `agy`; `-p`/`--print` takes the next argument as the prompt, so it goes last. */
const geminiReply = (attempt: RefineAttempt, executable: string) => {
  const model = isNamedModel(attempt.model, ["default", "gemini", "auto"]) ? [attempt.model.trim()] : [];
  const agyEffort = AGY_EFFORTS[attempt.effort.toLowerCase()];
  const args =
    path.basename(executable).toLowerCase() === "agy"
      ? [
          "--output-format",
          "json",
          ...model.flatMap((name) => ["--model", name]),
          ...(agyEffort === undefined ? [] : ["--effort", agyEffort]),
          "--print",
          refinePromptFor(attempt.draft),
        ]
      : ["-p", refinePromptFor(attempt.draft), ...model.flatMap((name) => ["-m", name])];
  return Effect.map(
    runSucceeded(attempt, { executable, args }),
    (cliRun) => replyTextFromJson(cliRun.stdout) || cliOutputText(cliRun),
  );
};

/** pi (pi-coding-agent) print mode: no tools, no saved session; the model may carry a ":thinking" suffix. */
const piReply = (attempt: RefineAttempt, executable: string) => {
  const effort = attempt.effort.toLowerCase();
  const thinking = ["minimal", "low", "medium", "high", "xhigh", "off", "max"].includes(effort) ? effort : "low";
  return Effect.map(
    runSucceeded(attempt, {
      executable,
      args: [
        "--no-tools",
        "--no-session",
        "--mode",
        "text",
        ...(isNamedModel(attempt.model, ["default", "pi-latest"]) ? ["--model", attempt.model.trim()] : []),
        ...(effort === "" ? [] : ["--thinking", thinking]),
        "-p",
        refinePromptFor(attempt.draft),
      ],
    }),
    (cliRun) => replyTextFromJson(cliRun.stdout) || cliOutputText(cliRun),
  );
};

const providerReply = (attempt: RefineAttempt): Effect.Effect<string, RefineAttemptFailed> => {
  switch (attempt.provider) {
    case "codex":
      return Effect.flatMap(requireCli(attempt, ["codex"]), (cli) => codexReply(attempt, cli));
    case "grok":
      return Effect.flatMap(requireCli(attempt, ["grok", "agent"]), (cli) => grokReply(attempt, cli));
    case "ollama":
      return Effect.flatMap(requireCli(attempt, ["ollama"]), (cli) => ollamaReply(attempt, cli));
    case "opencode":
      return Effect.flatMap(requireCli(attempt, ["opencode"]), (cli) => opencodeReply(attempt, cli));
    case "claude":
      return Effect.flatMap(requireCli(attempt, ["claude"]), (cli) => claudeReply(attempt, cli));
    case "gemini":
      return Effect.flatMap(requireCli(attempt, ["gemini", "agy"]), (cli) => geminiReply(attempt, cli));
    case "pi":
      return Effect.flatMap(requireCli(attempt, ["pi", "pie"]), (cli) => piReply(attempt, cli));
  }
};

/** One provider + model attempt with no rotation: the checked, refined prompt, or why it failed. */
export const refineWithProvider = (attempt: RefineAttempt): Effect.Effect<string, RefineAttemptFailed> =>
  Effect.flatMap(providerReply(attempt), (reply) => {
    if (looksLikeFailedModelOutput(reply)) {
      return Effect.fail(fail(attempt, reply || `${attempt.provider} refine failed`));
    }

    return Either.match(checkRefinedPrompt({ draft: attempt.draft, refined: reply }), {
      onLeft: (rejected) => Effect.fail(fail(attempt, rejected.message)),
      onRight: Effect.succeed,
    });
  });
