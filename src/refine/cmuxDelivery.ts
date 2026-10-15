/** Deliver refined prompts into cmux: a new focused workspace, or the focused (resumable) surface. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";
import { writePrivateFile } from "../files/stateFiles.js";
import type { Config } from "../settings/configSchema.js";
import { stateFolder } from "../settings/voxkeyHome.js";
import { cliFailureText, findCli, runCli } from "./agentCli.js";

export class CmuxDeliveryFailed extends Schema.TaggedError<CmuxDeliveryFailed>()("CmuxDeliveryFailed", {
  step: Schema.String,
  detail: Schema.String,
}) {
  get message(): string {
    return `cmux ${this.step}: ${this.detail}`;
  }
}

const CMUX_TIMEOUT_MS = 15_000;

const KNOWN_CMUX_PATHS = [
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
  "/usr/local/bin/cmux",
  "/opt/homebrew/bin/cmux",
];

const cmuxExecutable = (): string =>
  Option.getOrElse(findCli("cmux"), () => KNOWN_CMUX_PATHS.find((candidate) => existsSync(candidate)) || "cmux");

const recordOf = Schema.decodeUnknownOption(Schema.Record({ key: Schema.String, value: Schema.Unknown }));

const parseJson = Schema.decodeUnknownOption(Schema.parseJson());

/** The first of `keys` that holds a non-empty string. */
const firstString = (value: unknown, keys: ReadonlyArray<string>): Option.Option<string> =>
  Option.flatMap(recordOf(value), (record) =>
    Option.firstSomeOf(
      keys.map((key) => Option.filter(Schema.decodeUnknownOption(Schema.String)(record[key]), (text) => text !== "")),
    ),
  );

/** Run cmux and decode its JSON reply (the last JSON line, since cmux may print notices first). */
const cmuxJson = (request: { readonly args: ReadonlyArray<string>; readonly step: string }) =>
  Effect.gen(function* () {
    const cliRun = yield* runCli({
      executable: cmuxExecutable(),
      args: request.args,
      timeoutMs: CMUX_TIMEOUT_MS,
      environment: { CMUX_QUIET: "1" },
    }).pipe(Effect.mapError((error) => new CmuxDeliveryFailed({ step: request.step, detail: error.message })));
    if (cliRun.exitCode !== 0) {
      return yield* new CmuxDeliveryFailed({ step: request.step, detail: cliFailureText(cliRun) || "failed" });
    }

    const lastJsonLine = cliRun.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .at(-1);
    return Option.getOrElse(
      Option.orElse(parseJson(cliRun.stdout.trim()), () => parseJson(lastJsonLine || "")),
      () => null,
    );
  });

/** cmux addresses a surface by `surface_ref` (`surface:N`) or by `surface_id` (UUID). */
export const surfaceParams = (
  surface: string,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  [surface.startsWith("surface:") ? "surface_ref" : "surface_id"]: surface,
  ...fields,
});

const rpc = (method: string, params: Readonly<Record<string, string>>) =>
  cmuxJson({ args: ["rpc", method, JSON.stringify(params)], step: `rpc ${method}` });

const sendTextToSurface = (request: {
  readonly surface: string;
  readonly text: string;
  readonly pressEnter: boolean;
}) =>
  Effect.gen(function* () {
    yield* rpc("surface.send_text", surfaceParams(request.surface, { text: request.text }));
    if (request.pressEnter) {
      // Some cmux builds name the key "return" instead of "enter".
      yield* rpc("surface.send_key", surfaceParams(request.surface, { key: "enter" })).pipe(
        Effect.orElse(() => rpc("surface.send_key", surfaceParams(request.surface, { key: "return" }))),
        Effect.ignore,
      );
    }
  });

/** The focused (else calling) surface from `cmux identify`. */
const identifyFocus = Effect.map(
  cmuxJson({ args: ["identify", "--json", "--id-format", "both"], step: "identify" }),
  (identity) =>
    Option.getOrElse(
      Option.flatMap(recordOf(identity), (record) =>
        Option.orElse(Option.fromNullable(record.focused), () => Option.fromNullable(record.caller)),
      ),
      () => identity,
    ),
);

const workspaceListSchema = Schema.Struct({
  workspaces: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const workspaceDirectory = (workspace: unknown) => firstString(workspace, ["current_directory"]);

/** The focused workspace's folder, else the first workspace's, else HOME. */
const deliveryFolder = Effect.gen(function* () {
  const listing = yield* Effect.option(cmuxJson({ args: ["workspace", "list", "--json"], step: "workspace list" }));
  const workspaces = Option.getOrElse(
    Option.map(
      Option.flatMap(listing, Schema.decodeUnknownOption(workspaceListSchema)),
      (decoded) => decoded.workspaces,
    ),
    () => [],
  );
  const focusId = Option.getOrElse(
    Option.flatMap(yield* Effect.option(identifyFocus), (focus) =>
      firstString(focus, ["workspace_id", "workspace_ref"]),
    ),
    () => "",
  );
  const isFocused = (workspace: unknown) => {
    const id = Option.getOrElse(firstString(workspace, ["id", "workspace_id", "ref"]), () => "");
    return focusId !== "" && id !== "" && (id === focusId || id.endsWith(focusId) || focusId.endsWith(id));
  };
  const focused = workspaces.find(isFocused);
  const chosen = Option.orElse(Option.flatMap(Option.fromNullable(focused), workspaceDirectory), () =>
    Option.firstSomeOf(workspaces.map(workspaceDirectory)),
  );
  return Option.getOrElse(chosen, () => homedir());
});

/** Safe inside a single-quoted shell string: ' becomes '\''. */
export const shellSingleQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The template with each placeholder replaced by one shell-quoted word, in a single pass, so a folder or file name
 * with spaces or `$(...)` stays one literal argument and a placeholder inside the prompt text is never expanded.
 */
export const expandCommandTemplate = (request: {
  readonly template: string;
  readonly prompt: string;
  readonly promptFile: string;
  readonly folder: string;
}): string => {
  const values: Readonly<Record<string, string>> = {
    prompt_file: request.promptFile,
    prompt: request.prompt,
    cwd: request.folder,
  };
  return request.template.replace(/\{\{(prompt_file|prompt|cwd)\}\}/gu, (_placeholder, name: string) =>
    shellSingleQuote(values[name] || ""),
  );
};

export const workspaceTitle = (text: string): string => {
  const firstLine = [...(text.split("\n")[0] || "").trim()].slice(0, 40).join("");
  return firstLine === "" ? "refine" : `refine: ${firstLine}`;
};

const writePromptFile = (text: string): string => {
  const promptFile = path.join(stateFolder("prompts"), `prompt-${randomUUID()}.txt`);
  writePrivateFile({ path: promptFile, flags: "w", contents: `${text}\n` });
  return promptFile;
};

const deliverToNewWorkspace = (request: { readonly text: string; readonly config: Config }) =>
  Effect.gen(function* () {
    const folder = yield* deliveryFolder;
    const create = ["workspace", "create", "--name", workspaceTitle(request.text), "--cwd", folder, "--focus", "true"];
    if (request.config.refineCmuxCommand !== "") {
      const command = expandCommandTemplate({
        template: request.config.refineCmuxCommand,
        prompt: request.text,
        promptFile: writePromptFile(request.text),
        folder,
      });
      const created = yield* cmuxJson({ args: [...create, "--command", command, "--json"], step: "workspace create" });
      const workspace = Option.getOrElse(firstString(created, ["workspace_ref", "workspace_id"]), () => "?");
      return `cmux-new ran a command in workspace ${workspace}`;
    }

    const created = yield* cmuxJson({ args: [...create, "--json"], step: "workspace create" });
    const surface = firstString(created, ["surface_id", "surface_ref"]);
    if (Option.isNone(surface)) {
      return yield* new CmuxDeliveryFailed({ step: "workspace create", detail: "no surface id in the reply" });
    }

    // Give the new terminal a moment to accept input.
    yield* Effect.sleep("350 millis");
    yield* sendTextToSurface({
      surface: surface.value,
      text: request.text,
      pressEnter: request.config.refineCmuxPressEnter,
    });
    return `cmux-new pasted into surface ${surface.value}`;
  });

const deliverToFocusedSurface = (request: { readonly text: string; readonly config: Config }) =>
  Effect.gen(function* () {
    const surface = firstString(yield* identifyFocus, ["surface_id", "surface_ref"]);
    if (Option.isNone(surface)) {
      return yield* new CmuxDeliveryFailed({ step: "identify", detail: "no focused surface" });
    }

    yield* sendTextToSurface({
      surface: surface.value,
      text: request.text,
      pressEnter: request.config.refineCmuxPressEnter,
    });
    return `cmux-resume sent to surface ${surface.value}`;
  });

/** Send refined text where `refineSendTo` says; returns a one-line summary for the dictation log. */
export const deliverToCmux = (request: {
  readonly text: string;
  readonly config: Config;
}): Effect.Effect<string, CmuxDeliveryFailed> => {
  const text = request.text.trim();
  switch (request.config.refineSendTo) {
    case "cmux-new":
      return deliverToNewWorkspace({ text, config: request.config });
    case "cmux-resume":
      return deliverToFocusedSurface({ text, config: request.config });
    case "caret":
      return Effect.fail(new CmuxDeliveryFailed({ step: "deliver", detail: "caret delivery types at the caret" }));
  }
};
