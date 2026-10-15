import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";
import { writePrivateFile } from "../files/stateFiles.js";
import { stateFolder } from "../settings/agentVoiceHome.js";
import type { Config } from "../settings/configSchema.js";
import { cliFailureText, findCli, nonBlankLines, runCli } from "./agentCli.js";

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

const knownCmuxPath = (): string => KNOWN_CMUX_PATHS.find((candidate) => existsSync(candidate)) || "cmux";

const cmuxExecutable = (): string => findCli("cmux").pipe(Option.getOrElse(knownCmuxPath));

const recordOf = Schema.decodeUnknownOption(Schema.Record({ key: Schema.String, value: Schema.Unknown }));

const parseJson = Schema.decodeUnknownOption(Schema.parseJson());

const decodeString = Schema.decodeUnknownOption(Schema.String);

const nonEmptyString = (value: unknown): Option.Option<string> =>
  decodeString(value).pipe(Option.filter((text) => text !== ""));

const firstString = (value: unknown, keys: ReadonlyArray<string>): Option.Option<string> =>
  recordOf(value).pipe(
    Option.flatMap((record) => {
      const candidates = keys.map((key) => nonEmptyString(record[key]));
      return Option.firstSomeOf(candidates);
    }),
  );

// cmux may print notices before its JSON line.
const cmuxReply = (stdout: string): unknown => {
  const jsonLines = nonBlankLines(stdout).filter((line) => line.startsWith("{"));
  const lastJsonLine = jsonLines.at(-1) || "";
  const wholeText = stdout.trim();
  return parseJson(wholeText).pipe(
    Option.orElse(() => parseJson(lastJsonLine)),
    Option.getOrNull,
  );
};

const cmuxJson = (request: { readonly args: ReadonlyArray<string>; readonly step: string }) =>
  Effect.gen(function* () {
    const executable = cmuxExecutable();
    const cliRun = yield* runCli({
      executable,
      args: request.args,
      timeoutMs: CMUX_TIMEOUT_MS,
      environment: { CMUX_QUIET: "1" },
    }).pipe(Effect.mapError((error) => new CmuxDeliveryFailed({ step: request.step, detail: error.message })));
    if (cliRun.exitCode !== 0) {
      const detail = cliFailureText(cliRun) || "failed";
      return yield* new CmuxDeliveryFailed({ step: request.step, detail });
    }

    return cmuxReply(cliRun.stdout);
  });

// cmux addresses a surface by `surface_ref` (`surface:N`) or by `surface_id` (UUID).
const surfaceKey = (surface: string): string => {
  if (surface.startsWith("surface:")) {
    return "surface_ref";
  }

  return "surface_id";
};

export const surfaceParams = (
  surface: string,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const key = surfaceKey(surface);
  return { [key]: surface, ...fields };
};

const rpc = (method: string, params: Readonly<Record<string, string>>) => {
  const paramsJson = JSON.stringify(params);
  return cmuxJson({ args: ["rpc", method, paramsJson], step: `rpc ${method}` });
};

// Some cmux builds name the key "return" instead of "enter".
const pressEnterKey = (surface: string): Effect.Effect<void> => {
  const enterParams = surfaceParams(surface, { key: "enter" });
  const returnParams = surfaceParams(surface, { key: "return" });
  return rpc("surface.send_key", enterParams).pipe(
    Effect.orElse(() => rpc("surface.send_key", returnParams)),
    Effect.ignore,
  );
};

const sendTextToSurface = (request: {
  readonly surface: string;
  readonly text: string;
  readonly pressEnter: boolean;
}) =>
  Effect.gen(function* () {
    const textParams = surfaceParams(request.surface, { text: request.text });
    yield* rpc("surface.send_text", textParams);
    if (request.pressEnter) {
      yield* pressEnterKey(request.surface);
    }
  });

const focusedOrCaller = (identity: unknown): unknown =>
  recordOf(identity).pipe(
    Option.flatMap((record) => {
      const focused = Option.fromNullable(record.focused);
      return focused.pipe(Option.orElse(() => Option.fromNullable(record.caller)));
    }),
    Option.getOrElse(() => identity),
  );

const identifyFocus = cmuxJson({ args: ["identify", "--json", "--id-format", "both"], step: "identify" }).pipe(
  Effect.map(focusedOrCaller),
);

const workspaceListSchema = Schema.Struct({
  workspaces: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const decodeWorkspaceList = Schema.decodeUnknownOption(workspaceListSchema);

const workspacesIn = (listing: unknown): ReadonlyArray<unknown> =>
  decodeWorkspaceList(listing).pipe(
    Option.map((decoded) => decoded.workspaces),
    Option.getOrElse(() => []),
  );

const listWorkspaces = cmuxJson({ args: ["workspace", "list", "--json"], step: "workspace list" }).pipe(
  Effect.map(workspacesIn),
  Effect.orElseSucceed(() => []),
);

const focusedWorkspaceId = (focus: unknown): string =>
  firstString(focus, ["workspace_id", "workspace_ref"]).pipe(Option.getOrElse(() => ""));

const workspaceDirectory = (workspace: unknown) => firstString(workspace, ["current_directory"]);

const isFocusedWorkspace = (workspace: unknown, focusId: string): boolean => {
  const id = firstString(workspace, ["id", "workspace_id", "ref"]).pipe(Option.getOrElse(() => ""));
  if (id === "" || focusId === "") {
    return false;
  }

  return id === focusId || id.endsWith(focusId) || focusId.endsWith(id);
};

const firstWorkspaceDirectory = (workspaces: ReadonlyArray<unknown>): Option.Option<string> => {
  const directories = workspaces.map(workspaceDirectory);
  return Option.firstSomeOf(directories);
};

const deliveryFolder = Effect.gen(function* () {
  const workspaces = yield* listWorkspaces;
  const focusId = yield* identifyFocus.pipe(
    Effect.map(focusedWorkspaceId),
    Effect.orElseSucceed(() => ""),
  );
  const focused = workspaces.find((workspace) => isFocusedWorkspace(workspace, focusId));
  return Option.fromNullable(focused).pipe(
    Option.flatMap(workspaceDirectory),
    Option.orElse(() => firstWorkspaceDirectory(workspaces)),
    Option.getOrElse(homedir),
  );
});

// Safe inside a single-quoted shell string: ' becomes '\''.
export const shellSingleQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// One pass, so a folder with spaces or `$(...)` stays one literal word and a placeholder inside the prompt is never expanded.
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
  const firstLine = text.split("\n")[0] || "";
  const characters = [...firstLine.trim()];
  const shortLine = characters.slice(0, 40).join("");
  if (shortLine === "") {
    return "refine";
  }

  return `refine: ${shortLine}`;
};

const writePromptFile = (text: string): string => {
  const promptsFolder = stateFolder("prompts");
  const promptFile = path.join(promptsFolder, `prompt-${randomUUID()}.txt`);
  writePrivateFile({ path: promptFile, flags: "w", contents: `${text}\n` });
  return promptFile;
};

const createWorkspaceArgs = (text: string, folder: string): ReadonlyArray<string> => {
  const title = workspaceTitle(text);
  return ["workspace", "create", "--name", title, "--cwd", folder, "--focus", "true"];
};

const runInNewWorkspace = (request: { readonly text: string; readonly template: string; readonly folder: string }) =>
  Effect.gen(function* () {
    const promptFile = writePromptFile(request.text);
    const command = expandCommandTemplate({
      template: request.template,
      prompt: request.text,
      promptFile,
      folder: request.folder,
    });
    const createArgs = createWorkspaceArgs(request.text, request.folder);
    const created = yield* cmuxJson({
      args: [...createArgs, "--command", command, "--json"],
      step: "workspace create",
    });
    const workspace = firstString(created, ["workspace_ref", "workspace_id"]).pipe(Option.getOrElse(() => "?"));
    return `cmux-new ran a command in workspace ${workspace}`;
  });

const pasteInNewWorkspace = (request: {
  readonly text: string;
  readonly folder: string;
  readonly pressEnter: boolean;
}) =>
  Effect.gen(function* () {
    const createArgs = createWorkspaceArgs(request.text, request.folder);
    const created = yield* cmuxJson({ args: [...createArgs, "--json"], step: "workspace create" });
    const surface = firstString(created, ["surface_id", "surface_ref"]);
    if (Option.isNone(surface)) {
      return yield* new CmuxDeliveryFailed({ step: "workspace create", detail: "no surface id in the reply" });
    }

    // Give the new terminal a moment to accept input.
    yield* Effect.sleep("350 millis");
    yield* sendTextToSurface({ surface: surface.value, text: request.text, pressEnter: request.pressEnter });
    return `cmux-new pasted into surface ${surface.value}`;
  });

const deliverToNewWorkspace = (request: { readonly text: string; readonly config: Config }) =>
  Effect.gen(function* () {
    const folder = yield* deliveryFolder;
    const template = request.config.refineCmuxCommand;
    if (template !== "") {
      return yield* runInNewWorkspace({ text: request.text, template, folder });
    }

    return yield* pasteInNewWorkspace({
      text: request.text,
      folder,
      pressEnter: request.config.refineCmuxPressEnter,
    });
  });

const deliverToFocusedSurface = (request: { readonly text: string; readonly config: Config }) =>
  Effect.gen(function* () {
    const focus = yield* identifyFocus;
    const surface = firstString(focus, ["surface_id", "surface_ref"]);
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

// Returns a one-line summary for the dictation log.
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
