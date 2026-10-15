// voxkey's one Stop entry is added and removed by text edits at jsonc-parser offsets: comments, key order, and spacing
// of everything else stay byte for byte, and removing the entry right after adding it restores the original text.

import { Either, Option, Schema } from "effect";
import { findNodeAtLocation, getNodeValue, type Node, type ParseError, parseTree } from "jsonc-parser";

import type { AgentId } from "./agentCatalog.js";

export class HookSettingsIssue extends Schema.TaggedError<HookSettingsIssue>()("HookSettingsIssue", {
  issue: Schema.String,
}) {
  get message(): string {
    return this.issue;
  }
}

type SettingsEdit = { readonly source: string; readonly changed: boolean };

type ReplyHookLocation = {
  readonly stopArray: Node;
  readonly group: Node;
  readonly groupHooks: Node;
  readonly hook: Node;
};

type HookInsertion = { readonly container: Node; readonly keyPrefix: string; readonly value: unknown };

// POSIX single quotes: the shell expands nothing inside them, and an embedded ' is closed, escaped, and reopened.
const shellQuoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// `'<node>' [loader flags] '<voxkey main>' reply --agent <id>`: the command that identifies voxkey's entry.
export const replyHookCommand = (request: {
  readonly nodePath: string;
  readonly scriptArguments: ReadonlyArray<string>;
  readonly agent: AgentId;
}): string =>
  [shellQuoted(request.nodePath), ...request.scriptArguments.map(shellQuoted), "reply", "--agent", request.agent].join(
    " ",
  );

const QUOTED_WORD = String.raw`'(?:[^']|'\\'')*'`;

const MAIN_SCRIPT_WORD = String.raw`'(?:[^']|'\\'')*/src/cli/main\.[jt]s'`;

// Matches voxkey's entry from any install path, but only in the exact shape replyHookCommand writes.
export const isReplyHookCommand = (command: string, agent: AgentId): boolean => {
  const replyHookPattern = new RegExp(`^(?:${QUOTED_WORD} )+${MAIN_SCRIPT_WORD} reply --agent ${agent}$`, "u");
  const trimmed = command.trim();
  return replyHookPattern.test(trimmed);
};

const parseSettings = (source: string): Either.Either<Node, HookSettingsIssue> => {
  const errors: Array<ParseError> = [];
  const root = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || root === undefined || root.type !== "object") {
    return Either.left(new HookSettingsIssue({ issue: "the settings file is not a JSON object" }));
  }

  return Either.right(root);
};

const lineIndent = (source: string, offset: number): string => {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const line = source.slice(lineStart);
  return /^[ \t]*/u.exec(line)?.[0] || "";
};

const indentUnit = (source: string): string => /\n([ \t]+)"/u.exec(source)?.[1] || "  ";

const pretty = (request: { readonly value: unknown; readonly unit: string; readonly baseIndent: string }) =>
  JSON.stringify(request.value, null, request.unit).split("\n").join(`\n${request.baseIndent}`);

const splice = (source: string, edit: { readonly offset: number; readonly length: number; readonly text: string }) =>
  source.slice(0, edit.offset) + edit.text + source.slice(edit.offset + edit.length);

// The new member is indented like its siblings, or one unit deeper than an empty container.
const appendMember = (request: {
  readonly source: string;
  readonly container: Node;
  readonly member: (indent: string) => string;
}) => {
  const children = request.container.children || [];
  const last = children.at(-1);
  if (last !== undefined) {
    const indent = lineIndent(request.source, last.offset);
    return splice(request.source, {
      offset: last.offset + last.length,
      length: 0,
      text: `,\n${indent}${request.member(indent)}`,
    });
  }

  const outerIndent = lineIndent(request.source, request.container.offset);
  const innerIndent = outerIndent + indentUnit(request.source);
  return splice(request.source, {
    offset: request.container.offset + 1,
    length: request.container.length - 2,
    text: `\n${innerIndent}${request.member(innerIndent)}\n${outerIndent}`,
  });
};

// The member goes with the separator that belongs to it, so the remaining text reads as before.
const removeMember = (request: {
  readonly source: string;
  readonly container: Node;
  readonly member: Node;
}): string => {
  const children = request.container.children || [];
  const index = children.indexOf(request.member);
  const previous = children[index - 1];
  const next = children[index + 1];
  if (previous !== undefined) {
    return splice(request.source, {
      offset: previous.offset + previous.length,
      length: request.member.offset + request.member.length - (previous.offset + previous.length),
      text: "",
    });
  }

  if (next !== undefined) {
    return splice(request.source, {
      offset: request.member.offset,
      length: next.offset - request.member.offset,
      text: "",
    });
  }

  return splice(request.source, {
    offset: request.container.offset + 1,
    length: request.container.length - 2,
    text: "",
  });
};

const decodeString = Schema.decodeUnknownOption(Schema.String);

const commandOf = (hook: Node): string => {
  const commandNode = findNodeAtLocation(hook, ["command"]);
  return Option.fromNullable(commandNode).pipe(
    Option.map(getNodeValue),
    Option.flatMap(decodeString),
    Option.getOrElse(() => ""),
  );
};

const findReplyHook = (root: Node, matches: (command: string) => boolean): Option.Option<ReplyHookLocation> => {
  const stopArray = findNodeAtLocation(root, ["hooks", "Stop"]);
  if (stopArray?.type !== "array") {
    return Option.none();
  }

  const locations = (stopArray.children || []).flatMap((group) => {
    const groupHooks = findNodeAtLocation(group, ["hooks"]);
    if (groupHooks?.type !== "array") {
      return [];
    }

    return (groupHooks.children || []).map((hook) => ({ stopArray, group, groupHooks, hook }));
  });
  const location = locations.find((candidate) => {
    const command = commandOf(candidate.hook);
    return matches(command);
  });
  return Option.fromNullable(location);
};

const isEmptyContainer = (node: Node | undefined): boolean =>
  (node?.type === "array" || node?.type === "object") && (node.children || []).length === 0;

// Remove an object property, or nothing, once removing voxkey's entry left its value empty.
const pruneIfEmpty = (request: { readonly source: string; readonly path: ReadonlyArray<string> }): string => {
  const parsed = parseSettings(request.source);
  if (Either.isLeft(parsed)) {
    return request.source;
  }

  const parentPath = request.path.slice(0, -1);
  const key = request.path.at(-1) || "";
  const parent = findNodeAtLocation(parsed.right, parentPath);
  const property = (parent?.children || []).find((candidate) => candidate.children?.[0]?.value === key);
  const hasEmptyValue = isEmptyContainer(property?.children?.[1]);
  if (parent === undefined || property === undefined || !hasEmptyValue) {
    return request.source;
  }

  return removeMember({ source: request.source, container: parent, member: property });
};

// A group that also holds other hooks keeps them; a group holding only voxkey's hook goes whole.
const removeHookEntry = (source: string, location: ReplyHookLocation): string => {
  const hasOtherHooks = (location.groupHooks.children || []).length > 1;
  if (hasOtherHooks) {
    return removeMember({ source, container: location.groupHooks, member: location.hook });
  }

  return removeMember({ source, container: location.stopArray, member: location.group });
};

// A container left empty by the removal goes too.
export const removeReplyHook = (request: {
  readonly source: string;
  readonly agent: AgentId;
}): Either.Either<SettingsEdit, HookSettingsIssue> =>
  parseSettings(request.source).pipe(
    Either.map((root) => {
      const location = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));
      if (Option.isNone(location)) {
        return { source: request.source, changed: false };
      }

      const withoutHook = removeHookEntry(request.source, location.value);
      const withoutStop = pruneIfEmpty({ source: withoutHook, path: ["hooks", "Stop"] });
      const withoutHooks = pruneIfEmpty({ source: withoutStop, path: ["hooks"] });
      return { source: withoutHooks, changed: true };
    }),
  );

// voxkey's hook group goes into the Stop array, into a new Stop key in hooks, or into a new hooks key.
const hookInsertion = (root: Node, command: string): Either.Either<HookInsertion, HookSettingsIssue> => {
  const hookGroup = { hooks: [{ type: "command", command }] };
  const hooks = findNodeAtLocation(root, ["hooks"]);
  const stopArray = findNodeAtLocation(root, ["hooks", "Stop"]);
  if (hooks !== undefined && hooks.type !== "object") {
    return Either.left(new HookSettingsIssue({ issue: "hooks is not an object" }));
  }

  if (stopArray !== undefined && stopArray.type !== "array") {
    return Either.left(new HookSettingsIssue({ issue: "hooks.Stop is not an array" }));
  }

  if (stopArray !== undefined) {
    return Either.right({ container: stopArray, keyPrefix: "", value: hookGroup });
  }

  if (hooks !== undefined) {
    return Either.right({ container: hooks, keyPrefix: '"Stop": ', value: [hookGroup] });
  }

  return Either.right({ container: root, keyPrefix: '"hooks": ', value: { Stop: [hookGroup] } });
};

const appendReplyHook = (source: string, command: string): Either.Either<string, HookSettingsIssue> =>
  parseSettings(source).pipe(
    Either.flatMap((root) => hookInsertion(root, command)),
    Either.map((insertion) => {
      const unit = indentUnit(source);
      return appendMember({
        source,
        container: insertion.container,
        member: (indent) => `${insertion.keyPrefix}${pretty({ value: insertion.value, unit, baseIndent: indent })}`,
      });
    }),
  );

const settingsText = (source: string): string => {
  const isBlank = source.trim() === "";
  if (isBlank) {
    return "{}\n";
  }

  return source;
};

const confirmAdded = (edited: string, command: string): Either.Either<SettingsEdit, HookSettingsIssue> =>
  parseSettings(edited).pipe(
    Either.map((root) => findReplyHook(root, (found) => found === command)),
    Either.filterOrLeft(
      Option.isSome,
      () => new HookSettingsIssue({ issue: "the edited settings lost voxkey's entry" }),
    ),
    Either.map(() => ({ source: edited, changed: true })),
  );

const replaceReplyHook = (request: {
  readonly source: string;
  readonly command: string;
  readonly agent: AgentId;
}): Either.Either<SettingsEdit, HookSettingsIssue> =>
  removeReplyHook({ source: request.source, agent: request.agent }).pipe(
    Either.flatMap((cleared) => appendReplyHook(cleared.source, request.command)),
    Either.flatMap((edited) => confirmAdded(edited, request.command)),
  );

// Replaces an older voxkey entry for the same agent, so a moved install keeps one entry.
export const addReplyHook = (request: {
  readonly source: string;
  readonly command: string;
  readonly agent: AgentId;
}): Either.Either<SettingsEdit, HookSettingsIssue> => {
  const source = settingsText(request.source);
  return parseSettings(source).pipe(
    Either.flatMap((root): Either.Either<SettingsEdit, HookSettingsIssue> => {
      const existing = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));
      const isCurrent = Option.exists(existing, (location) => commandOf(location.hook) === request.command);
      if (isCurrent) {
        return Either.right({ source: request.source, changed: false });
      }

      return replaceReplyHook({ source, command: request.command, agent: request.agent });
    }),
  );
};

// `{}` and whitespace with no comment, so voxkey may then delete its own file.
export const isEmptySettings = (source: string): boolean => source.replace(/\s/gu, "") === "{}";
