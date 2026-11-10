import { containsAny, listNonBlankLines, parseDocumentOrNull } from "./agent-cli.js";

const OUTPUT_KEY = "output";

const CONTENT_KEY = "content";

const RESULT_KEY = "result";

const TEXT_PART_TYPE = "text";

const STRING_KIND = "string";

const REJECTED_STATUS = "rejected";

const CODE_FENCE = "```";

const NEWLINE = "\n";

const DROPPED_LITERAL_REASON = "droppedLiteral";

const CLI_HELP_REASON = "cliHelp";

const EMPTY_REASON = "empty";

const GLOBAL_UNICODE_FLAGS = "gu";

const OPEN_BRACE = "{";

const MESSAGE_FIELD = "message";

const POSITIONALS_LABEL = "positionals:";

export const createRefinePrompt = (draft: string): string =>
  `${`You refine messy freeform or spoken drafts into a single paste-ready prompt for a coding agent.

Rules:
1. Preserve exact intent, facts, constraints, code, commands, paths, URLs, quoted literals, and acceptance criteria.
2. Remove filler, false starts, and repetition. Make implied deliverables explicit only when already supported by the draft.
3. Prefer routing to existing skills when the draft is clearly that workflow (finish-and-push, organize-commits, simplify-code, clean-repo-by-feature, run-tasks-in-parallel, run-local-and-check, deploy-and-check, which-skill, etc.). Lead with the primary skill id when helpful: "finish-and-push: …".
4. Do not invent a multi-skill plan, a routing chat, or a long report. Output is the agent message the user would paste/send next.
5. Do not answer the prompt. Do not add commentary, labels, Markdown fences around the whole reply, or invented requirements.
6. Return only the revised prompt text.`}\n\nDraft to refine:\n---\n${draft}\n---\nReturn only the revised prompt text.`;

// A CLI --help dump (say, OpenCode's yargs help printed with exit 0), not a refined prompt.
export const isCliHelpScreen = (string: string): boolean => {
  const lowercase = string.trim().toLowerCase();
  const helpAnchors = [POSITIONALS_LABEL, "options:", "show help", "[boolean]"].filter((anchor) =>
    lowercase.includes(anchor),
  );
  const isOpencodeHelp =
    (lowercase.includes("run opencode with a message") && lowercase.includes(POSITIONALS_LABEL)) ||
    lowercase.startsWith("opencode run [message") ||
    lowercase.includes("opencode run [message..]");
  const minimumHelpAnchorCount = 3;

  return helpAnchors.length >= minimumHelpAnchorCount || isOpencodeHelp;
};

export const isAuthFailureMessage = (string: string): boolean =>
  containsAny(string, [
    "no api key found",
    "use /login",
    "not logged in",
    "not signed in",
    "no models available",
    "please log in",
    "authentication required",
    "unauthorized",
    "login required",
  ]);

export const isModelUnavailableError = (message: string): boolean =>
  containsAny(message, [
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
  ]);

// Error phrases only: a refined prompt about a budget, a billing page, a disk quota, or RPM is a real prompt.
export const isQuotaOrLimitError = (message: string): boolean =>
  containsAny(message, [
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
  ]);

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
  const isPaymentError =
    lowercase.startsWith("402") || containsAny(lowercase, ['"code":402', '"code": 402', "invalid_request_error"]);
  const hasErrorFields =
    lowercase.includes('"error"') ||
    (lowercase.includes('"code"') && containsAny(lowercase, [MESSAGE_FIELD, "credits"]));
  const isDocumentError = trimmed.startsWith(OPEN_BRACE) && hasErrorFields;
  return isKnownFailure || isPaymentError || isDocumentError;
};

const NOT_WORD_CHARACTER_BEFORE = "(?<![\\p{L}\\p{N}_])";

const LITERAL_PATTERNS = [
  /```[\s\S]*?```/gu,
  /`[^`\n]+`/gu,
  /https?:\/\/[^\s<>()]+/gu,
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:\\.{0,2}/)[^\\s,;:!?]+`, GLOBAL_UNICODE_FLAGS),
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+`, GLOBAL_UNICODE_FLAGS),
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:'[^'\\n]+'|"[^"\\n]+")`, GLOBAL_UNICODE_FLAGS),
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
    case EMPTY_REASON:
      return "The model returned an empty prompt";
    case CLI_HELP_REASON:
      return "The model returned CLI help text instead of a refined prompt";
    case DROPPED_LITERAL_REASON:
      return `The model changed a protected literal: ${rejection.literal ?? ""}`;
  }
};

const stripWholeReplyFence = (string: string): string => {
  const lines = string.split(NEWLINE);

  const minimumFencedLineCount = 2;

  const isNotFenced =
    !string.startsWith(CODE_FENCE) || !string.endsWith(CODE_FENCE) || lines.length < minimumFencedLineCount;
  if (isNotFenced) {
    return string;
  }

  return lines.slice(1, -1).join(NEWLINE).trim();
};

export const checkRefinedPrompt = (request: {
  readonly draft: string;
  readonly refined: string;
}): RefinedPromptCheck => {
  const trimmed = request.refined.trim();
  const refinedPrompt = stripWholeReplyFence(trimmed);

  const isPromptEmpty = refinedPrompt === "";
  if (isPromptEmpty) {
    return { status: REJECTED_STATUS, rejection: { reason: EMPTY_REASON } };
  }

  const isCliHelpReply = isCliHelpScreen(refinedPrompt);
  if (isCliHelpReply) {
    return { status: REJECTED_STATUS, rejection: { reason: CLI_HELP_REASON } };
  }

  const literals = listPromptLiterals(request.draft);
  const droppedLiteral = literals.find((literal) => !refinedPrompt.includes(literal));

  const hasDroppedLiteral = droppedLiteral != null;
  if (hasDroppedLiteral) {
    return { status: REJECTED_STATUS, rejection: { reason: DROPPED_LITERAL_REASON, literal: droppedLiteral } };
  }

  return { status: "accepted", prompt: refinedPrompt };
};

type DocumentObject = Readonly<Record<string, unknown>>;

const isDocumentObject = (field: unknown): field is DocumentObject =>
  typeof field === "object" && field !== null && !Array.isArray(field);

const isNonNullPiece = (string: string | null): string is string => string != null;

const readNonBlankField = (field: unknown): string | null => {
  const isStringField = typeof field === STRING_KIND;

  const isNotStringField = !isStringField;
  if (isNotStringField) {
    return null;
  }

  const trimmed = field.trim();
  const isBlank = trimmed === "";
  return isBlank ? null : trimmed;
};

const readFieldOrEmpty = (field: unknown): string => {
  const isStringField = typeof field === STRING_KIND;

  const isNotStringField = !isStringField;
  if (isNotStringField) {
    return "";
  }

  return field;
};

// A block keeps its text as sent, blank included, so the joined reply keeps its line breaks.
const readBlockReply = (block: unknown): string | null => {
  const blockField = isDocumentObject(block) ? block.text : null;

  const isNotStringField = typeof blockField !== STRING_KIND;
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

  const joined = field.map(readBlockReply).filter(isNonNullPiece).join(NEWLINE);
  return readNonBlankField(joined);
};

// OpenCode streams {type, part: {type, text}} events; only text parts hold the reply.
const isReplyPart = (event: DocumentObject, part: DocumentObject): boolean => {
  const partType = readFieldOrEmpty(part.type);
  const eventType = readFieldOrEmpty(event.type);
  return partType === "" || partType === TEXT_PART_TYPE || eventType === TEXT_PART_TYPE;
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
  const keyReplies = [RESULT_KEY, TEXT_PART_TYPE, CONTENT_KEY, MESSAGE_FIELD, OUTPUT_KEY, "response"].map((key) =>
    readFieldReply(document, key),
  );
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
  const directFields = [RESULT_KEY, TEXT_PART_TYPE, CONTENT_KEY, MESSAGE_FIELD, OUTPUT_KEY]
    .map((key) => readNonBlankField(event[key]))
    .filter(isNonNullPiece);
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
    .filter((line) => line.startsWith(OPEN_BRACE))
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

  return parts.join(NEWLINE).trim();
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
