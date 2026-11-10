// agent-voice's one Stop entry is added and removed by text edits at jsonc-parser offsets: comments, key order, and spacing
// of everything else stay byte for byte, and removing the entry right after adding it restores the original text.

import { findNodeAtLocation, getNodeValue, type Node, type ParseError, parseTree } from "jsonc-parser";

import type { AgentId } from "./agent-catalog.js";

export interface SettingsEdit {
  readonly source: string;
  readonly changed: boolean;
}

interface ReplyHookLocation {
  readonly stopArray: Node;
  readonly group: Node;
  readonly groupHooks: Node;
  readonly hook: Node;
}

interface HookInsertion {
  readonly container: Node;
  readonly keyPrefix: string;
  readonly value: unknown;
}

// POSIX single quotes: the shell expands nothing inside them, and an embedded ' is closed, escaped, and reopened.
const shellQuoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// `'<node>' [loader flags] '<agent-voice main>' reply --agent <id>`: the command that identifies agent-voice's entry.
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

// Matches agent-voice's entry from any install path, but only in the exact shape replyHookCommand writes.
export const isReplyHookCommand = (command: string, agent: AgentId): boolean => {
  const replyHookPattern = new RegExp(`^(?:${QUOTED_WORD} )+${MAIN_SCRIPT_WORD} reply --agent ${agent}$`, "u");
  const trimmed = command.trim();
  return replyHookPattern.test(trimmed);
};

// Throws when the text is not one JSON object, so the caller reports the file as failed and leaves it alone.
const parseSettings = (source: string): Node => {
  const errors: Array<ParseError> = [];
  const root = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });

  const isRootObject = root?.type === "object";

  const isSettingsUnreadable = errors.length > 0 || !isRootObject;
  if (isSettingsUnreadable) {
    throw new Error("the settings file is not a JSON object");
  }

  return root;
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

  const hasLast = last !== undefined;
  if (hasLast) {
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

  const hasPrevious = previous !== undefined;
  if (hasPrevious) {
    return splice(request.source, {
      offset: previous.offset + previous.length,
      length: request.member.offset + request.member.length - (previous.offset + previous.length),
      text: "",
    });
  }

  const hasNext = next !== undefined;
  if (hasNext) {
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

const commandOf = (hook: Node): string => {
  const commandNode = findNodeAtLocation(hook, ["command"]);

  const isThereNoCommandNode = commandNode === undefined;
  if (isThereNoCommandNode) {
    return "";
  }

  const commandValue: unknown = getNodeValue(commandNode);
  const isCommandText = typeof commandValue === "string";
  return isCommandText ? commandValue : "";
};

const findReplyHook = (root: Node, matches: (command: string) => boolean): ReplyHookLocation | null => {
  const stopArray = findNodeAtLocation(root, ["hooks", "Stop"]);

  const isStopArrayTypeNotArray = stopArray?.type !== "array";
  if (isStopArrayTypeNotArray) {
    return null;
  }

  const locations = (stopArray.children || []).flatMap((group) => {
    const groupHooks = findNodeAtLocation(group, ["hooks"]);

    const isGroupHooksTypeNotArray = groupHooks?.type !== "array";
    if (isGroupHooksTypeNotArray) {
      return [];
    }

    return (groupHooks.children || []).map((hook) => ({ stopArray, group, groupHooks, hook }));
  });
  const location = locations.find((candidate) => {
    const command = commandOf(candidate.hook);
    return matches(command);
  });
  return location ?? null;
};

const isEmptyContainer = (node: Node | undefined): boolean =>
  (node?.type === "array" || node?.type === "object") && (node.children || []).length === 0;

// Remove an object property, or nothing, once removing agent-voice's entry left its value empty.
const pruneIfEmpty = (request: { readonly source: string; readonly path: ReadonlyArray<string> }): string => {
  const root = parseSettings(request.source);
  const parentPath = request.path.slice(0, -1);
  const key = request.path.at(-1) || "";
  const parent = findNodeAtLocation(root, parentPath);
  const property = (parent?.children || []).find((candidate) => candidate.children?.[0]?.value === key);

  const hasEmptyValue = isEmptyContainer(property?.children?.[1]);

  const isNothingToRemove = parent === undefined || property === undefined || !hasEmptyValue;
  if (isNothingToRemove) {
    return request.source;
  }

  return removeMember({ source: request.source, container: parent, member: property });
};

// A group that also holds other hooks keeps them; a group holding only agent-voice's hook goes whole.
const removeHookEntry = (source: string, location: ReplyHookLocation): string => {
  const hasOtherHooks = (location.groupHooks.children || []).length > 1;
  if (hasOtherHooks) {
    return removeMember({ source, container: location.groupHooks, member: location.hook });
  }

  return removeMember({ source, container: location.stopArray, member: location.group });
};

// A container left empty by the removal goes too.
export const removeReplyHook = (request: { readonly source: string; readonly agent: AgentId }): SettingsEdit => {
  const root = parseSettings(request.source);
  const location = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));

  const isThereNoReplyHook = location === null;
  if (isThereNoReplyHook) {
    return { source: request.source, changed: false };
  }

  const withoutHook = removeHookEntry(request.source, location);
  const withoutStop = pruneIfEmpty({ source: withoutHook, path: ["hooks", "Stop"] });
  const withoutHooks = pruneIfEmpty({ source: withoutStop, path: ["hooks"] });
  return { source: withoutHooks, changed: true };
};

// agent-voice's hook group goes into the Stop array, into a new Stop key in hooks, or into a new hooks key.
const hookInsertion = (root: Node, command: string): HookInsertion => {
  const hookGroup = { hooks: [{ type: "command", command }] };
  const hooks = findNodeAtLocation(root, ["hooks"]);
  const stopArray = findNodeAtLocation(root, ["hooks", "Stop"]);

  const isHooksWrongType = hooks !== undefined && hooks.type !== "object";
  if (isHooksWrongType) {
    throw new Error("hooks is not an object");
  }

  const isStopArrayWrongType = stopArray !== undefined && stopArray.type !== "array";
  if (isStopArrayWrongType) {
    throw new Error("hooks.Stop is not an array");
  }

  const hasStopArray = stopArray !== undefined;
  if (hasStopArray) {
    return { container: stopArray, keyPrefix: "", value: hookGroup };
  }

  const hasHooks = hooks !== undefined;
  if (hasHooks) {
    return { container: hooks, keyPrefix: '"Stop": ', value: [hookGroup] };
  }

  return { container: root, keyPrefix: '"hooks": ', value: { Stop: [hookGroup] } };
};

const appendReplyHook = (source: string, command: string): string => {
  const root = parseSettings(source);
  const insertion = hookInsertion(root, command);
  const unit = indentUnit(source);
  return appendMember({
    source,
    container: insertion.container,
    member: (indent) => `${insertion.keyPrefix}${pretty({ value: insertion.value, unit, baseIndent: indent })}`,
  });
};

const settingsText = (source: string): string => {
  const isBlank = source.trim() === "";
  if (isBlank) {
    return "{}\n";
  }

  return source;
};

const confirmAdded = (edited: string, command: string): SettingsEdit => {
  const root = parseSettings(edited);
  const addedLocation = findReplyHook(root, (found) => found === command);

  const isAddedLost = addedLocation === null;
  if (isAddedLost) {
    throw new Error("the edited settings lost agent-voice's entry");
  }

  return { source: edited, changed: true };
};

const replaceReplyHook = (request: {
  readonly source: string;
  readonly command: string;
  readonly agent: AgentId;
}): SettingsEdit => {
  const cleared = removeReplyHook({ source: request.source, agent: request.agent });
  const edited = appendReplyHook(cleared.source, request.command);
  return confirmAdded(edited, request.command);
};

// Replaces an older agent-voice entry for the same agent, so a moved install keeps one entry.
export const addReplyHook = (request: {
  readonly source: string;
  readonly command: string;
  readonly agent: AgentId;
}): SettingsEdit => {
  const source = settingsText(request.source);
  const root = parseSettings(source);
  const existing = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));

  const isCurrent = existing !== null && commandOf(existing.hook) === request.command;
  if (isCurrent) {
    return { source: request.source, changed: false };
  }

  return replaceReplyHook({ source, command: request.command, agent: request.agent });
};

// `{}` and whitespace with no comment, so agent-voice may then delete its own file.
export const isEmptySettings = (source: string): boolean => source.replace(/\s/gu, "") === "{}";
