import { containsAny, listNonBlankLines, parseDocumentOrNull } from "./agent-cli.js";

const REFINE_INSTRUCTIONS = `You refine messy freeform or spoken drafts into a single paste-ready prompt for a coding agent.

Rules:
1. Preserve exact intent, facts, constraints, code, commands, paths, URLs, quoted literals, and acceptance criteria.
2. Remove filler, false starts, and repetition. Make implied deliverables explicit only when already supported by the draft.
3. Prefer routing to existing skills when the draft is clearly that workflow (finish-and-push, organize-commits, simplify-code, clean-repo-by-feature, run-tasks-in-parallel, run-local-and-check, deploy-and-check, which-skill, etc.). Lead with the primary skill id when helpful: "finish-and-push: …".
4. Do not invent a multi-skill plan, a routing chat, or a long report. Output is the agent message the user would paste/send next.
5. Do not answer the prompt. Do not add commentary, labels, Markdown fences around the whole reply, or invented requirements.
6. Return only the revised prompt text.`;

export const createRefinePrompt = (draft: string): string =>
  `${REFINE_INSTRUCTIONS}\n\nDraft to refine:\n---\n${draft}\n---\nReturn only the revised prompt text.`;

// Agent CLIs that print auth or help failures with exit code 0.
const AUTH_OR_SETTINGS_MARKERS = [
  "no api key found",
  "use /login",
  "not logged in",
  "not signed in",
  "no models available",
  "please log in",
  "authentication required",
  "unauthorized",
  "login required",
];

const MODEL_UNAVAILABLE_MARKERS = [
  "model is not supported",
  "model not found",
  "unknown model",
  "invalid model",
  "unsupported model",
  "does not exist",
  "not available for",
  "not supported when using",
  "model_not_found",
  "invalid_model",
  "no such model",
  "the requested model is not supported",
  "model_not_supported",
];

// Error phrases only: a refined prompt about a budget, a billing page, a disk quota, or RPM is a real prompt.
const QUOTA_OR_LIMIT_MARKERS = [
  "quota exceeded",
  "quota_exceeded",
  "resource_exhausted",
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  'status":429',
  "status code 429",
  "http 429",
  " 429",
  " 402",
  'status":402',
  "usage limit",
  "usage_limit",
  "insufficient_quota",
  "exceeded your current quota",
  "billing details",
  "billing_hard_limit",
  "billing hard limit",
  "limit reached",
  "tokens per min",
  "requests per min",
  "out of credits",
  "requires more credits",
  "can only afford",
  "openrouter.ai/settings/credits",
  "payment required",
  "spending limit",
  "budget exceeded",
  "budget has been exceeded",
  "exceeded your budget",
  "credit balance",
  "insufficient credits",
];

const PAYMENT_ERROR_MARKERS = ['"code":402', '"code": 402', "invalid_request_error"];

const HELP_ANCHORS = ["positionals:", "options:", "show help", "[boolean]"];

// A CLI --help dump (say, OpenCode's yargs help printed with exit 0), not a refined prompt.
export const isCliHelpScreen = (string: string): boolean => {
  const lowercase = string.trim().toLowerCase();
  const helpAnchors = HELP_ANCHORS.filter((anchor) => lowercase.includes(anchor));
  const isOpencodeHelp =
    (lowercase.includes("run opencode with a message") && lowercase.includes("positionals:")) ||
    lowercase.startsWith("opencode run [message") ||
    lowercase.includes("opencode run [message..]");
  return helpAnchors.length >= 3 || isOpencodeHelp;
};

export const isAuthFailureMessage = (string: string): boolean => containsAny(string, AUTH_OR_SETTINGS_MARKERS);

export const isModelUnavailableError = (message: string): boolean => containsAny(message, MODEL_UNAVAILABLE_MARKERS);

export const isQuotaOrLimitError = (message: string): boolean => containsAny(message, QUOTA_OR_LIMIT_MARKERS);

// Several agents (pi, OpenRouter wrappers) print 402 or JSON errors with exit code 0; those must never reach the caret.
export const isFailedModelReply = (string: string): boolean => {
  const trimmed = string.trim();
  const lowercase = trimmed.toLowerCase();
  const isKnownFailure =
    trimmed === "" ||
    isCliHelpScreen(trimmed) ||
    isAuthFailureMessage(trimmed) ||
    isQuotaOrLimitError(trimmed) ||
    isModelUnavailableError(trimmed);
  const isPaymentError = lowercase.startsWith("402") || containsAny(lowercase, PAYMENT_ERROR_MARKERS);
  const hasErrorFields =
    lowercase.includes('"error"') || (lowercase.includes('"code"') && containsAny(lowercase, ["message", "credits"]));
  const isDocumentError = trimmed.startsWith("{") && hasErrorFields;
  return isKnownFailure || isPaymentError || isDocumentError;
};

const NOT_WORD_CHARACTER_BEFORE = "(?<![\\p{L}\\p{N}_])";

const LITERAL_PATTERNS = [
  /```[\s\S]*?```/gu,
  /`[^`\n]+`/gu,
  /https?:\/\/[^\s<>()]+/gu,
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:\\.{0,2}/)[^\\s,;:!?]+`, "gu"),
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+`, "gu"),
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:'[^'\\n]+'|"[^"\\n]+")`, "gu"),
];

type LiteralSpan = { readonly start: number; readonly end: number; readonly literal: string };

const listLiteralSpans = (string: string, pattern: RegExp): ReadonlyArray<LiteralSpan> =>
  [...string.matchAll(pattern)].map((literalFound) => ({
    start: literalFound.index,
    end: literalFound.index + literalFound[0].length,
    literal: literalFound[0],
  }));

const readLength = (literalSpan: LiteralSpan): number => literalSpan.end - literalSpan.start;

const isOverlapping = (left: LiteralSpan, right: LiteralSpan): boolean =>
  left.start < right.end && right.start < left.end;

// Of two overlapping matches the longer one wins (earlier patterns on a tie), so a quote that holds a URL stays whole.
export const listPromptLiterals = (string: string): ReadonlyArray<string> => {
  const candidates = LITERAL_PATTERNS.flatMap((pattern) => listLiteralSpans(string, pattern));
  const longestFirst = [...candidates].sort((left, right) => readLength(right) - readLength(left));
  const kept: Array<LiteralSpan> = [];
  for (const candidate of longestFirst) {
    const isNotOverlapping = !kept.some((taken) => isOverlapping(candidate, taken));
    if (isNotOverlapping) {
      kept.push(candidate);
    }
  }

  return candidates.filter((candidate) => kept.includes(candidate)).map((candidate) => candidate.literal);
};

export interface RefineReplyRejection {
  readonly reason: "empty" | "cliHelp" | "droppedLiteral";
  readonly literal?: string;
}

export type RefinedPromptCheck =
  | { readonly status: "accepted"; readonly prompt: string }
  | { readonly status: "rejected"; readonly rejection: RefineReplyRejection };

export const describeRefineReplyRejection = (rejection: RefineReplyRejection): string => {
  switch (rejection.reason) {
    case "empty":
      return "The model returned an empty prompt";
    case "cliHelp":
      return "The model returned CLI help text instead of a refined prompt";
    case "droppedLiteral":
      return `The model changed a protected literal: ${rejection.literal ?? ""}`;
  }
};

const stripWholeReplyFence = (string: string): string => {
  const lines = string.split("\n");

  const isNotFenced = !string.startsWith("```") || !string.endsWith("```") || lines.length < 2;
  if (isNotFenced) {
    return string;
  }

  return lines.slice(1, -1).join("\n").trim();
};

export const checkRefinedPrompt = (request: {
  readonly draft: string;
  readonly refined: string;
}): RefinedPromptCheck => {
  const trimmed = request.refined.trim();
  const refinedPrompt = stripWholeReplyFence(trimmed);

  const isPromptEmpty = refinedPrompt === "";
  if (isPromptEmpty) {
    return { status: "rejected", rejection: { reason: "empty" } };
  }

  const isCliHelpReply = isCliHelpScreen(refinedPrompt);
  if (isCliHelpReply) {
    return { status: "rejected", rejection: { reason: "cliHelp" } };
  }

  const literals = listPromptLiterals(request.draft);
  const droppedLiteral = literals.find((literal) => !refinedPrompt.includes(literal));

  const hasDroppedLiteral = droppedLiteral != null;
  if (hasDroppedLiteral) {
    return { status: "rejected", rejection: { reason: "droppedLiteral", literal: droppedLiteral } };
  }

  return { status: "accepted", prompt: refinedPrompt };
};

type DocumentObject = Readonly<Record<string, unknown>>;

const DOCUMENT_STRING_KEYS = ["result", "text", "content", "message", "output", "response"];
const EVENT_STRING_KEYS = ["result", "text", "content", "message", "output"];

const isDocumentObject = (field: unknown): field is DocumentObject =>
  typeof field === "object" && field !== null && !Array.isArray(field);

const isNonNullPiece = (string: string | null): string is string => string != null;

// The trimmed text, or null when the value is not a string or is blank.
const readNonBlankField = (field: unknown): string | null => {
  const isStringField = typeof field === "string";

  const isNotStringField = !isStringField;
  if (isNotStringField) {
    return null;
  }

  const trimmed = field.trim();
  const isBlank = trimmed === "";
  return isBlank ? null : trimmed;
};

const readFieldOrEmpty = (field: unknown): string => {
  const isStringField = typeof field === "string";

  const isNotStringField = !isStringField;
  if (isNotStringField) {
    return "";
  }

  return field;
};

// A block keeps its text as sent, blank included, so the joined reply keeps its line breaks.
const readBlockReply = (block: unknown): string | null => {
  const blockField = isDocumentObject(block) ? block.text : null;

  const isNotStringField = typeof blockField !== "string";
  if (isNotStringField) {
    return null;
  }

  return blockField;
};

const readJoinedBlocks = (field: unknown): string | null => {
  const isNotBlockList = !Array.isArray(field);
  if (isNotBlockList) {
    return null;
  }

  const joined = field.map(readBlockReply).filter(isNonNullPiece).join("\n");
  return readNonBlankField(joined);
};

// OpenCode streams {type, part: {type, text}} events; only text parts hold the reply.
const isReplyPart = (event: DocumentObject, part: DocumentObject): boolean => {
  const partType = readFieldOrEmpty(part.type);
  const eventType = readFieldOrEmpty(event.type);
  return partType === "" || partType === "text" || eventType === "text";
};

const readPartReply = (event: DocumentObject): string | null => {
  const part = event.part;

  const isNotReplyPart = !isDocumentObject(part) || !isReplyPart(event, part);
  if (isNotReplyPart) {
    return null;
  }

  return readNonBlankField(part.text);
};

const readNestedReply = (field: unknown): string | null => {
  const isNotObject = !isDocumentObject(field);
  if (isNotObject) {
    return null;
  }

  return readNonBlankField(field.text) ?? readNonBlankField(field.content);
};

const readFieldReply = (document: DocumentObject, key: string): string | null =>
  readNonBlankField(document[key]) ?? readNestedReply(document[key]);

const readDocumentReply = (document: DocumentObject): string | null => {
  const keyReplies = DOCUMENT_STRING_KEYS.map((key) => readFieldReply(document, key));
  const firstKeyReply = keyReplies.find(isNonNullPiece) ?? null;
  return firstKeyReply ?? readPartReply(document) ?? readJoinedBlocks(document.content);
};

const readMessageReply = (event: DocumentObject): string | null => {
  const message = event.message;

  const isNotObjectMessage = !isDocumentObject(message);
  if (isNotObjectMessage) {
    return null;
  }

  return readNonBlankField(message.content) ?? readJoinedBlocks(message.content);
};

const readEventReply = (event: DocumentObject): string | null => {
  const directFields = EVENT_STRING_KEYS.map((key) => readNonBlankField(event[key])).filter(isNonNullPiece);
  const lastDirectReply = directFields.at(-1) ?? null;
  return readMessageReply(event) ?? readPartReply(event) ?? lastDirectReply;
};

// A whole reply that is one JSON string or one JSON document with text in it.
const readWholeReply = (printout: string): string | null => {
  const whole = parseDocumentOrNull(printout);
  const wholeReply = readNonBlankField(whole);

  const hasWholeReply = wholeReply != null;
  if (hasWholeReply) {
    return wholeReply;
  }

  return isDocumentObject(whole) ? readDocumentReply(whole) : null;
};

const listDocumentLineEvents = (printout: string): ReadonlyArray<DocumentObject> =>
  listNonBlankLines(printout)
    .filter((line) => line.startsWith("{"))
    .map(parseDocumentOrNull)
    .filter(isDocumentObject);

const pickLongerReply = (best: string, part: string): string => {
  const isPartLengthAboveBestLength = part.length > best.length;
  if (isPartLengthAboveBestLength) {
    return part;
  }

  return best;
};

// Streamed parts are often cumulative: the longest wins when it already holds the rest.
const readJoinedParts = (parts: ReadonlyArray<string>): string => {
  const longest = parts.reduce(pickLongerReply, "");

  const holdsEveryPart = parts.every((part) => longest.includes(part));
  if (holdsEveryPart) {
    return longest;
  }

  return parts.join("\n").trim();
};

export const readReplyFromDocument = (printout: string): string => {
  const trimmed = printout.trim();

  const isTrimmedEmpty = trimmed === "";
  if (isTrimmedEmpty) {
    return "";
  }

  const wholeReply = readWholeReply(trimmed);

  const hasWholeReply = wholeReply != null;
  if (hasWholeReply) {
    return wholeReply;
  }

  const events = listDocumentLineEvents(trimmed);
  const parts = events.map(readPartReply).filter(isNonNullPiece);

  const hasParts = parts.length > 0;
  if (hasParts) {
    return readJoinedParts(parts);
  }

  const eventFields = events.map(readEventReply).filter(isNonNullPiece);
  return eventFields.at(-1) ?? "";
};
