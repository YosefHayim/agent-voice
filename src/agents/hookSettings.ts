/**
 * voxkey's one Stop entry in an agent settings file, added and removed by text edits at jsonc-parser
 * offsets: comments, key order, and spacing of everything else stay byte for byte, and removing the
 * entry right after adding it restores the original text.
 */

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

// POSIX single quotes: the shell expands nothing inside them, and an embedded ' is closed, escaped, and reopened.
const shellQuoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** `'<node>' [loader flags] '<voxkey main>' reply --agent <id>`: the command that identifies voxkey's entry. */
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

/**
 * voxkey's entry for this agent, whatever path voxkey was installed at when it was written: only the exact shape
 * replyHookCommand writes (quoted words ending in voxkey's `src/cli/main` script, then `reply --agent <id>`).
 */
export const isReplyHookCommand = (command: string, agent: AgentId): boolean =>
  new RegExp(`^(?:${QUOTED_WORD} )+${MAIN_SCRIPT_WORD} reply --agent ${agent}$`, "u").test(command.trim());

const hookGroupFor = (command: string) => ({ hooks: [{ type: "command", command }] });

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
  return /^[ \t]*/u.exec(source.slice(lineStart))?.[0] || "";
};

const indentUnit = (source: string): string => /\n([ \t]+)"/u.exec(source)?.[1] || "  ";

const pretty = (request: { readonly value: unknown; readonly unit: string; readonly baseIndent: string }) =>
  JSON.stringify(request.value, null, request.unit).split("\n").join(`\n${request.baseIndent}`);

const splice = (source: string, edit: { readonly offset: number; readonly length: number; readonly text: string }) =>
  source.slice(0, edit.offset) + edit.text + source.slice(edit.offset + edit.length);

/** Insert `text` as the last member of an array or object node, indented like its siblings. */
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

/** Delete one member together with the separator that belongs to it, so the remaining text reads as before. */
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

type ReplyHookLocation = {
  readonly stopArray: Node;
  readonly group: Node;
  readonly groupHooks: Node;
  readonly hook: Node;
};

const commandOf = (hook: Node): string =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullable(findNodeAtLocation(hook, ["command"])), (node) =>
      Schema.decodeUnknownOption(Schema.String)(getNodeValue(node)),
    ),
    () => "",
  );

const findReplyHook = (root: Node, matches: (command: string) => boolean): Option.Option<ReplyHookLocation> => {
  const stopArray = findNodeAtLocation(root, ["hooks", "Stop"]);
  if (stopArray?.type !== "array") {
    return Option.none();
  }

  const locations = (stopArray.children || []).flatMap((group) => {
    const groupHooks = findNodeAtLocation(group, ["hooks"]);
    const hooks = groupHooks?.type === "array" ? groupHooks.children || [] : [];
    return groupHooks === undefined ? [] : hooks.map((hook) => ({ stopArray, group, groupHooks, hook }));
  });
  return Option.fromNullable(locations.find((location) => matches(commandOf(location.hook))));
};

const propertyNode = (objectNode: Node, key: string): Option.Option<Node> =>
  Option.fromNullable((objectNode.children || []).find((property) => property.children?.[0]?.value === key));

// Remove an object property, or nothing, once removing voxkey's entry left its value empty.
const pruneIfEmpty = (request: { readonly source: string; readonly path: ReadonlyArray<string> }): string => {
  const root = Either.getOrUndefined(parseSettings(request.source));
  const parentPath = request.path.slice(0, -1);
  const parent = parentPath.length === 0 || root === undefined ? root : findNodeAtLocation(root, [...parentPath]);
  const property = parent === undefined ? Option.none() : propertyNode(parent, request.path.at(-1) || "");
  const value = Option.getOrUndefined(Option.map(property, (node) => node.children?.[1]));
  const isEmptyContainer =
    value !== undefined && (value.type === "array" || value.type === "object") && (value.children || []).length === 0;
  if (parent === undefined || Option.isNone(property) || !isEmptyContainer) {
    return request.source;
  }

  return removeMember({ source: request.source, container: parent, member: property.value });
};

/** Remove voxkey's Stop entry for this agent; a container left empty by the removal goes too. */
export const removeReplyHook = (request: {
  readonly source: string;
  readonly agent: AgentId;
}): Either.Either<SettingsEdit, HookSettingsIssue> =>
  Either.map(parseSettings(request.source), (root) => {
    const location = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));
    if (Option.isNone(location)) {
      return { source: request.source, changed: false };
    }

    const { stopArray, group, groupHooks, hook } = location.value;
    const withoutHook =
      (groupHooks.children || []).length > 1
        ? removeMember({ source: request.source, container: groupHooks, member: hook })
        : removeMember({ source: request.source, container: stopArray, member: group });
    const withoutStop = pruneIfEmpty({ source: withoutHook, path: ["hooks", "Stop"] });
    return { source: pruneIfEmpty({ source: withoutStop, path: ["hooks"] }), changed: true };
  });

const appendReplyHook = (source: string, command: string): Either.Either<string, HookSettingsIssue> =>
  Either.flatMap(parseSettings(source), (root) => {
    const unit = indentUnit(source);
    const stopArray = findNodeAtLocation(root, ["hooks", "Stop"]);
    if (stopArray !== undefined) {
      return stopArray.type === "array"
        ? Either.right(
            appendMember({
              source,
              container: stopArray,
              member: (indent) => pretty({ value: hookGroupFor(command), unit, baseIndent: indent }),
            }),
          )
        : Either.left(new HookSettingsIssue({ issue: "hooks.Stop is not an array" }));
    }

    const hooks = findNodeAtLocation(root, ["hooks"]);
    if (hooks !== undefined && hooks.type !== "object") {
      return Either.left(new HookSettingsIssue({ issue: "hooks is not an object" }));
    }

    const property =
      hooks === undefined
        ? { container: root, key: "hooks", value: { Stop: [hookGroupFor(command)] } }
        : { container: hooks, key: "Stop", value: [hookGroupFor(command)] };
    return Either.right(
      appendMember({
        source,
        container: property.container,
        member: (indent) => `"${property.key}": ${pretty({ value: property.value, unit, baseIndent: indent })}`,
      }),
    );
  });

/** Add voxkey's Stop entry with `command`, replacing an older voxkey entry for the same agent. */
export const addReplyHook = (request: {
  readonly source: string;
  readonly command: string;
  readonly agent: AgentId;
}): Either.Either<SettingsEdit, HookSettingsIssue> => {
  const source = request.source.trim() === "" ? "{}\n" : request.source;
  return Either.flatMap(parseSettings(source), (root): Either.Either<SettingsEdit, HookSettingsIssue> => {
    const existing = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));
    if (Option.isSome(existing) && commandOf(existing.value.hook) === request.command) {
      return Either.right({ source: request.source, changed: false });
    }

    const cleared = Either.getOrElse(
      removeReplyHook({ source, agent: request.agent }),
      (): SettingsEdit => ({
        source,
        changed: false,
      }),
    );
    return Either.flatMap(appendReplyHook(cleared.source, request.command), (edited) =>
      Either.flatMap(parseSettings(edited), (editedRoot) =>
        Option.isSome(findReplyHook(editedRoot, (command) => command === request.command))
          ? Either.right({ source: edited, changed: true })
          : Either.left(new HookSettingsIssue({ issue: "the edited settings lost voxkey's entry" })),
      ),
    );
  });
};

/** True when the settings text is `{}` and whitespace, with no comment (voxkey may then delete its own file). */
export const isEmptySettings = (source: string): boolean => source.replace(/\s/gu, "") === "{}";
