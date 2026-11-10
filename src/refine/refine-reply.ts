import { containsAny, listNonBlankLines, parseJsonOrNull } from "./agent-cli.js";

const REFINE_INSTRUCTIONS = `You refine messy freeform or spoken drafts into a single paste-ready prompt for a coding agent.

Rules:
1. Preserve exact intent, facts, constraints, code, commands, paths, URLs, quoted literals, and acceptance criteria.
2. Remove filler, false starts, and repetition. Make implied deliverables explicit only when already supported by the draft.
3. Prefer routing to existing skills when the draft is clearly that workflow (finish-and-push, organize-commits, simplify-code, clean-repo-by-feature, run-tasks-in-parallel, run-local-and-check, deploy-and-check, which-skill, etc.). Lead with the primary skill id when helpful: "finish-and-push: …".
4. Do not invent a multi-skill plan, a routing chat, or a long report. Output is the agent message the user would paste/send next.
5. Do not answer the prompt. Do not add commentary, labels, Markdown fences around the whole reply, or invented requirements.
6. Return only the revised prompt text.`;

export const createRefineRequestText = (draft: string): string =>
  `${REFINE_INSTRUCTIONS}\n\nDraft to refine:\n---\n${draft}\n---\nReturn only the revised prompt text.`;

// Agent CLIs that print auth or help failures with exit code 0.
const AUTH_OR_CONFIG_MARKERS = [
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
export const isCliHelpText = (text: string): boolean => {
  const lowercase = text.trim().toLowerCase();
  const helpAnchors = HELP_ANCHORS.filter((anchor) => lowercase.includes(anchor));
  const isOpencodeHelp =
    (lowercase.includes("run opencode with a message") && lowercase.includes("positionals:")) ||
    lowercase.startsWith("opencode run [message") ||
    lowercase.includes("opencode run [message..]");
  return helpAnchors.length >= 3 || isOpencodeHelp;
};

export const isAuthFailureText = (text: string): boolean => containsAny(text, AUTH_OR_CONFIG_MARKERS);

export const isModelUnavailableError = (message: string): boolean => containsAny(message, MODEL_UNAVAILABLE_MARKERS);

export const isQuotaOrLimitError = (message: string): boolean => containsAny(message, QUOTA_OR_LIMIT_MARKERS);

// Several agents (pi, OpenRouter wrappers) print 402 or JSON errors with exit code 0; those must never reach the caret.
export const isFailedModelOutputText = (text: string): boolean => {
  const trimmed = text.trim();
  const lowercase = trimmed.toLowerCase();
  const isKnownFailure =
    trimmed === "" ||
    isCliHelpText(trimmed) ||
    isAuthFailureText(trimmed) ||
    isQuotaOrLimitError(trimmed) ||
    isModelUnavailableError(trimmed);
  const isPaymentError = lowercase.startsWith("402") || containsAny(lowercase, PAYMENT_ERROR_MARKERS);
  const hasErrorFields =
    lowercase.includes('"error"') || (lowercase.includes('"code"') && containsAny(lowercase, ["message", "credits"]));
  const isJsonError = trimmed.startsWith("{") && hasErrorFields;
  return isKnownFailure || isPaymentError || isJsonError;
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

type LiteralMatch = { readonly start: number; readonly end: number; readonly literal: string };

const listLiteralMatches = (text: string, pattern: RegExp): ReadonlyArray<LiteralMatch> =>
  [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    literal: match[0],
  }));

const readLength = (match: LiteralMatch): number => match.end - match.start;

const isOverlapping = (left: LiteralMatch, right: LiteralMatch): boolean =>
  left.start < right.end && right.start < left.end;

// Of two overlapping matches the longer one wins (earlier patterns on a tie), so a quote that holds a URL stays whole.
export const listPromptLiterals = (text: string): ReadonlyArray<string> => {
  const candidates = LITERAL_PATTERNS.flatMap((pattern) => listLiteralMatches(text, pattern));
  const longestFirst = [...candidates].sort((left, right) => readLength(right) - readLength(left));
  const kept: Array<LiteralMatch> = [];
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

const stripWholeReplyFence = (text: string): string => {
  const lines = text.split("\n");

  const isNotFenced = !text.startsWith("```") || !text.endsWith("```") || lines.length < 2;
  if (isNotFenced) {
    return text;
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

  const isCliHelpReply = isCliHelpText(refinedPrompt);
  if (isCliHelpReply) {
    return { status: "rejected", rejection: { reason: "cliHelp" } };
  }

  const literals = listPromptLiterals(request.draft);
  const droppedLiteral = literals.find((literal) => !refinedPrompt.includes(literal));

  const hasDroppedLiteral = droppedLiteral !== undefined;
  if (hasDroppedLiteral) {
    return { status: "rejected", rejection: { reason: "droppedLiteral", literal: droppedLiteral } };
  }

  return { status: "accepted", prompt: refinedPrompt };
};

type JsonObject = Readonly<Record<string, unknown>>;

const DOCUMENT_TEXT_KEYS = ["result", "text", "content", "message", "output", "response"];
const EVENT_TEXT_KEYS = ["result", "text", "content", "message", "output"];

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTextPresent = (text: string | null): text is string => text !== null;

// The trimmed text, or null when the value is not a string or is blank.
const readNonBlankText = (value: unknown): string | null => {
  const isString = typeof value === "string";

  const isNotString = !isString;
  if (isNotString) {
    return null;
  }

  const trimmed = value.trim();
  const isBlank = trimmed === "";
  return isBlank ? null : trimmed;
};

const readStringOrEmpty = (value: unknown): string => {
  const isString = typeof value === "string";

  const isNotString = !isString;
  if (isNotString) {
    return "";
  }

  return value;
};

// A block keeps its text as sent, blank included, so the joined reply keeps its line breaks.
const blockText = (block: unknown): string | null => {
  const text = isJsonObject(block) ? block.text : undefined;

  const isNotTextString = typeof text !== "string";
  if (isNotTextString) {
    return null;
  }

  return text;
};

const readJoinedBlocks = (value: unknown): string | null => {
  const isNotBlockList = !Array.isArray(value);
  if (isNotBlockList) {
    return null;
  }

  const joined = value.map(blockText).filter(isTextPresent).join("\n");
  return readNonBlankText(joined);
};

// OpenCode streams {type, part: {type, text}} events; only text parts hold the reply.
const isTextPart = (event: JsonObject, part: JsonObject): boolean => {
  const partType = readStringOrEmpty(part.type);
  const eventType = readStringOrEmpty(event.type);
  return partType === "" || partType === "text" || eventType === "text";
};

const readPartText = (event: JsonObject): string | null => {
  const part = event.part;

  const isNotTextPart = !isJsonObject(part) || !isTextPart(event, part);
  if (isNotTextPart) {
    return null;
  }

  return readNonBlankText(part.text);
};

const readNestedText = (value: unknown): string | null => {
  const isNotObject = !isJsonObject(value);
  if (isNotObject) {
    return null;
  }

  return readNonBlankText(value.text) ?? readNonBlankText(value.content);
};

const readFieldText = (document: JsonObject, key: string): string | null =>
  readNonBlankText(document[key]) ?? readNestedText(document[key]);

const readDocumentText = (document: JsonObject): string | null => {
  const keyTexts = DOCUMENT_TEXT_KEYS.map((key) => readFieldText(document, key));
  const firstKeyText = keyTexts.find(isTextPresent) ?? null;
  return firstKeyText ?? readPartText(document) ?? readJoinedBlocks(document.content);
};

const readMessageText = (event: JsonObject): string | null => {
  const message = event.message;

  const isNotObjectMessage = !isJsonObject(message);
  if (isNotObjectMessage) {
    return null;
  }

  return readNonBlankText(message.content) ?? readJoinedBlocks(message.content);
};

const readEventText = (event: JsonObject): string | null => {
  const directTexts = EVENT_TEXT_KEYS.map((key) => readNonBlankText(event[key])).filter(isTextPresent);
  const lastDirectText = directTexts.at(-1) ?? null;
  return readMessageText(event) ?? readPartText(event) ?? lastDirectText;
};

// A whole reply that is one JSON string or one JSON document with text in it.
const readWholeReplyText = (output: string): string | null => {
  const whole = parseJsonOrNull(output);
  const wholeString = readNonBlankText(whole);

  const hasWholeString = wholeString !== null;
  if (hasWholeString) {
    return wholeString;
  }

  return isJsonObject(whole) ? readDocumentText(whole) : null;
};

const listJsonLineEvents = (output: string): ReadonlyArray<JsonObject> =>
  listNonBlankLines(output)
    .filter((line) => line.startsWith("{"))
    .map(parseJsonOrNull)
    .filter(isJsonObject);

const readLongerText = (best: string, part: string): string => {
  const isPartLengthAboveBestLength = part.length > best.length;
  if (isPartLengthAboveBestLength) {
    return part;
  }

  return best;
};

// Streamed parts are often cumulative: the longest wins when it already holds the rest.
const readJoinedParts = (parts: ReadonlyArray<string>): string => {
  const longest = parts.reduce(readLongerText, "");

  const holdsEveryPart = parts.every((part) => longest.includes(part));
  if (holdsEveryPart) {
    return longest;
  }

  return parts.join("\n").trim();
};

export const replyTextFromJson = (output: string): string => {
  const trimmed = output.trim();

  const isTrimmedEmpty = trimmed === "";
  if (isTrimmedEmpty) {
    return "";
  }

  const wholeText = readWholeReplyText(trimmed);

  const hasWholeText = wholeText !== null;
  if (hasWholeText) {
    return wholeText;
  }

  const events = listJsonLineEvents(trimmed);
  const parts = events.map(readPartText).filter(isTextPresent);

  const hasParts = parts.length > 0;
  if (hasParts) {
    return readJoinedParts(parts);
  }

  const eventTexts = events.map(readEventText).filter(isTextPresent);
  return eventTexts.at(-1) ?? "";
};
