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
const quoteShellWord = (string: string) => `'${string.replaceAll("'", "'\\''")}'`;

// `'<node>' [loader flags] '<agent-voice main>' reply --agent <id>`: the command that identifies agent-voice's entry.
export const replyHookCommand = (request: {
  readonly nodePath: string;
  readonly scriptArguments: ReadonlyArray<string>;
  readonly agent: AgentId;
}): string =>
  [
    quoteShellWord(request.nodePath),
    ...request.scriptArguments.map(quoteShellWord),
    "reply",
    "--agent",
    request.agent,
  ].join(" ");

const QUOTED_WORD = String.raw`'(?:[^']|'\\'')*'`;

const MAIN_SCRIPT_WORD = String.raw`'(?:[^']|'\\'')*/src/cli/main\.[jt]s'`;

// Matches agent-voice's entry from any install path, but only in the exact shape replyHookCommand writes.
export const isReplyHookCommand = (command: string, agent: AgentId): boolean => {
  const replyHookPattern = new RegExp(`^(?:${QUOTED_WORD} )+${MAIN_SCRIPT_WORD} reply --agent ${agent}$`, "u");
  const trimmed = command.trim();
  return replyHookPattern.test(trimmed);
};

// Throws when the text is not one JSON object, so the caller reports the file as failed and leaves it alone.
const parseSettings = (code: string): Node => {
  const errors: Array<ParseError> = [];
  const root = parseTree(code, errors, { allowTrailingComma: true, disallowComments: false });

  const isRootObject = root?.type === "object";

  const isSettingsUnreadable = errors.length > 0 || !isRootObject;
  if (isSettingsUnreadable) {
    throw new Error("the settings file is not a JSON object");
  }

  return root;
};

const readLineIndent = (code: string, offset: number): string => {
  const lineStart = code.lastIndexOf("\n", offset - 1) + 1;
  const line = code.slice(lineStart);
  return /^[ \t]*/u.exec(line)?.[0] || "";
};

const readIndentUnit = (code: string): string => /\n([ \t]+)"/u.exec(code)?.[1] || "  ";

const stringifyWithIndent = (request: {
  readonly value: unknown;
  readonly unit: string;
  readonly baseIndent: string;
}) => JSON.stringify(request.value, null, request.unit).split("\n").join(`\n${request.baseIndent}`);

const splice = (code: string, edit: { readonly offset: number; readonly length: number; readonly text: string }) =>
  code.slice(0, edit.offset) + edit.text + code.slice(edit.offset + edit.length);

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
    const indent = readLineIndent(request.source, last.offset);
    return splice(request.source, {
      offset: last.offset + last.length,
      length: 0,
      text: `,\n${indent}${request.member(indent)}`,
    });
  }

  const outerIndent = readLineIndent(request.source, request.container.offset);
  const innerIndent = outerIndent + readIndentUnit(request.source);
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

const readHookCommand = (hook: Node): string => {
  const commandNode = findNodeAtLocation(hook, ["command"]);

  const isThereNoCommandNode = commandNode === undefined;
  if (isThereNoCommandNode) {
    return "";
  }

  const commandField: unknown = getNodeValue(commandNode);
  const isCommandSet = typeof commandField === "string";
  return isCommandSet ? commandField : "";
};

const findReplyHook = (root: Node, hits: (command: string) => boolean): ReplyHookLocation | null => {
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
    const command = readHookCommand(candidate.hook);
    return hits(command);
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

  const hasEmptyField = isEmptyContainer(property?.children?.[1]);

  const isNothingToRemove = parent === undefined || property === undefined || !hasEmptyField;
  if (isNothingToRemove) {
    return request.source;
  }

  return removeMember({ source: request.source, container: parent, member: property });
};

// A group that also holds other hooks keeps them; a group holding only agent-voice's hook goes whole.
const removeHookLine = (code: string, location: ReplyHookLocation): string => {
  const hasOtherHooks = (location.groupHooks.children || []).length > 1;
  if (hasOtherHooks) {
    return removeMember({ source: code, container: location.groupHooks, member: location.hook });
  }

  return removeMember({ source: code, container: location.stopArray, member: location.group });
};

// A container left empty by the removal goes too.
export const removeReplyHook = (request: { readonly source: string; readonly agent: AgentId }): SettingsEdit => {
  const root = parseSettings(request.source);
  const location = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));

  const isThereNoReplyHook = location === null;
  if (isThereNoReplyHook) {
    return { source: request.source, changed: false };
  }

  const withoutHook = removeHookLine(request.source, location);
  const withoutStop = pruneIfEmpty({ source: withoutHook, path: ["hooks", "Stop"] });
  const withoutHooks = pruneIfEmpty({ source: withoutStop, path: ["hooks"] });
  return { source: withoutHooks, changed: true };
};

// agent-voice's hook group goes into the Stop array, into a new Stop key in hooks, or into a new hooks key.
const readHookInsertion = (root: Node, command: string): HookInsertion => {
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

const appendReplyHook = (code: string, command: string): string => {
  const root = parseSettings(code);
  const insertion = readHookInsertion(root, command);
  const unit = readIndentUnit(code);
  return appendMember({
    source: code,
    container: insertion.container,
    member: (indent) =>
      `${insertion.keyPrefix}${stringifyWithIndent({ value: insertion.value, unit, baseIndent: indent })}`,
  });
};

const pickSettingsDocument = (code: string): string => {
  const isBlank = code.trim() === "";
  if (isBlank) {
    return "{}\n";
  }

  return code;
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
  const code = pickSettingsDocument(request.source);
  const root = parseSettings(code);
  const existing = findReplyHook(root, (command) => isReplyHookCommand(command, request.agent));

  const isCurrent = existing !== null && readHookCommand(existing.hook) === request.command;
  if (isCurrent) {
    return { source: request.source, changed: false };
  }

  return replaceReplyHook({ source: code, command: request.command, agent: request.agent });
};

// `{}` and whitespace with no comment, so agent-voice may then delete its own file.
export const isEmptySettings = (code: string): boolean => code.replace(/\s/gu, "") === "{}";
