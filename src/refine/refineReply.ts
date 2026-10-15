import { Either, Option, Schema } from "effect";

import { containsAny, nonBlankLines } from "./agentCli.js";

const REFINE_INSTRUCTIONS = `You refine messy freeform or spoken drafts into a single paste-ready prompt for a coding agent.

Rules:
1. Preserve exact intent, facts, constraints, code, commands, paths, URLs, quoted literals, and acceptance criteria.
2. Remove filler, false starts, and repetition. Make implied deliverables explicit only when already supported by the draft.
3. Prefer routing to existing skills when the draft is clearly that workflow (finish-and-push, organize-commits, simplify-code, clean-repo-by-feature, run-tasks-in-parallel, run-local-and-check, deploy-and-check, which-skill, etc.). Lead with the primary skill id when helpful: "finish-and-push: …".
4. Do not invent a multi-skill plan, a routing chat, or a long report. Output is the agent message the user would paste/send next.
5. Do not answer the prompt. Do not add commentary, labels, Markdown fences around the whole reply, or invented requirements.
6. Return only the revised prompt text.`;

export const refinePromptFor = (draft: string): string =>
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
export const looksLikeCliHelp = (text: string): boolean => {
  const lowercase = text.trim().toLowerCase();
  const helpAnchors = HELP_ANCHORS.filter((anchor) => lowercase.includes(anchor));
  const isOpencodeHelp =
    (lowercase.includes("run opencode with a message") && lowercase.includes("positionals:")) ||
    lowercase.startsWith("opencode run [message") ||
    lowercase.includes("opencode run [message..]");
  return helpAnchors.length >= 3 || isOpencodeHelp;
};

export const looksLikeAuthFailure = (text: string): boolean => containsAny(text, AUTH_OR_CONFIG_MARKERS);

export const isModelUnavailableError = (message: string): boolean => containsAny(message, MODEL_UNAVAILABLE_MARKERS);

export const isQuotaOrLimitError = (message: string): boolean => containsAny(message, QUOTA_OR_LIMIT_MARKERS);

// Several agents (pi, OpenRouter wrappers) print 402 or JSON errors with exit code 0; those must never reach the caret.
export const looksLikeFailedModelOutput = (text: string): boolean => {
  const trimmed = text.trim();
  const lowercase = trimmed.toLowerCase();
  const isKnownFailure =
    trimmed === "" ||
    looksLikeCliHelp(trimmed) ||
    looksLikeAuthFailure(trimmed) ||
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

const literalMatches = (text: string, pattern: RegExp): ReadonlyArray<LiteralMatch> =>
  [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    literal: match[0],
  }));

const lengthOf = (match: LiteralMatch): number => match.end - match.start;

const overlaps = (left: LiteralMatch, right: LiteralMatch): boolean => left.start < right.end && right.start < left.end;

// Of two overlapping matches the longer one wins (earlier patterns on a tie), so a quote that holds a URL stays whole.
export const promptLiterals = (text: string): ReadonlyArray<string> => {
  const candidates = LITERAL_PATTERNS.flatMap((pattern) => literalMatches(text, pattern));
  const longestFirst = [...candidates].sort((left, right) => lengthOf(right) - lengthOf(left));
  const kept: Array<LiteralMatch> = [];
  for (const candidate of longestFirst) {
    const isOverlapping = kept.some((taken) => overlaps(candidate, taken));
    if (!isOverlapping) {
      kept.push(candidate);
    }
  }

  return candidates.filter((candidate) => kept.includes(candidate)).map((candidate) => candidate.literal);
};

export class RefineReplyRejected extends Schema.TaggedError<RefineReplyRejected>()("RefineReplyRejected", {
  reason: Schema.Literal("empty", "cliHelp", "droppedLiteral"),
  literal: Schema.optional(Schema.String),
}) {
  get message(): string {
    return {
      empty: "The model returned an empty prompt",
      cliHelp: "The model returned CLI help text instead of a refined prompt",
      droppedLiteral: `The model changed a protected literal: ${this.literal || ""}`,
    }[this.reason];
  }
}

const withoutWholeReplyFence = (text: string): string => {
  const lines = text.split("\n");
  const isFenced = text.startsWith("```") && text.endsWith("```") && lines.length >= 2;
  if (!isFenced) {
    return text;
  }

  return lines.slice(1, -1).join("\n").trim();
};

export const checkRefinedPrompt = (request: {
  readonly draft: string;
  readonly refined: string;
}): Either.Either<string, RefineReplyRejected> => {
  const trimmed = request.refined.trim();
  const refinedPrompt = withoutWholeReplyFence(trimmed);
  if (refinedPrompt === "") {
    return Either.left(new RefineReplyRejected({ reason: "empty" }));
  }

  if (looksLikeCliHelp(refinedPrompt)) {
    return Either.left(new RefineReplyRejected({ reason: "cliHelp" }));
  }

  const literals = promptLiterals(request.draft);
  const dropped = literals.find((literal) => !refinedPrompt.includes(literal));
  if (dropped !== undefined) {
    return Either.left(new RefineReplyRejected({ reason: "droppedLiteral", literal: dropped }));
  }

  return Either.right(refinedPrompt);
};

type JsonObject = Readonly<Record<string, unknown>>;

const decodeJson = Schema.decodeUnknownOption(Schema.parseJson());
const decodeObject = Schema.decodeUnknownOption(Schema.Record({ key: Schema.String, value: Schema.Unknown }));
const decodeString = Schema.decodeUnknownOption(Schema.String);
const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeTextBlock = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }));

const DOCUMENT_TEXT_KEYS = ["result", "text", "content", "message", "output", "response"];
const EVENT_TEXT_KEYS = ["result", "text", "content", "message", "output"];

const textOf = (value: unknown): Option.Option<string> =>
  decodeString(value).pipe(
    Option.map((text) => text.trim()),
    Option.filter((text) => text !== ""),
  );

const stringOf = (value: unknown): string => decodeString(value).pipe(Option.getOrElse(() => ""));

const blockText = (block: unknown): ReadonlyArray<string> =>
  decodeTextBlock(block).pipe(
    Option.map((decoded) => decoded.text),
    Option.toArray,
  );

const joinedBlocks = (value: unknown): Option.Option<string> => {
  const blocks = decodeArray(value).pipe(Option.getOrElse(() => []));
  const joined = blocks.flatMap(blockText).join("\n");
  return textOf(joined);
};

// OpenCode streams {type, part: {type, text}} events; only text parts hold the reply.
const isTextPart = (event: JsonObject, part: JsonObject): boolean => {
  const partType = stringOf(part.type);
  const eventType = stringOf(event.type);
  return partType === "" || partType === "text" || eventType === "text";
};

const partText = (event: JsonObject): Option.Option<string> =>
  decodeObject(event.part).pipe(
    Option.filter((part) => isTextPart(event, part)),
    Option.flatMap((part) => textOf(part.text)),
  );

const nestedText = (value: unknown): Option.Option<string> =>
  decodeObject(value).pipe(
    Option.flatMap((nested) => textOf(nested.text).pipe(Option.orElse(() => textOf(nested.content)))),
  );

const fieldText = (document: JsonObject, key: string): Option.Option<string> =>
  textOf(document[key]).pipe(Option.orElse(() => nestedText(document[key])));

const documentText = (document: JsonObject): Option.Option<string> => {
  const keyTexts = DOCUMENT_TEXT_KEYS.map((key) => fieldText(document, key));
  return Option.firstSomeOf(keyTexts).pipe(
    Option.orElse(() => partText(document)),
    Option.orElse(() => joinedBlocks(document.content)),
  );
};

const messageText = (event: JsonObject): Option.Option<string> =>
  decodeObject(event.message).pipe(
    Option.flatMap((message) => textOf(message.content).pipe(Option.orElse(() => joinedBlocks(message.content)))),
  );

const eventText = (event: JsonObject): Option.Option<string> => {
  const directTexts = EVENT_TEXT_KEYS.flatMap((key) => textOf(event[key]).pipe(Option.toArray));
  const lastDirectText = directTexts.at(-1);
  return messageText(event).pipe(
    Option.orElse(() => partText(event)),
    Option.orElse(() => Option.fromNullable(lastDirectText)),
  );
};

const wholeReplyText = (output: string): Option.Option<string> => {
  const whole = decodeJson(output);
  const wholeDocumentText = whole.pipe(Option.flatMap(decodeObject), Option.flatMap(documentText));
  return whole.pipe(
    Option.flatMap(textOf),
    Option.orElse(() => wholeDocumentText),
  );
};

const jsonLineEvents = (output: string): ReadonlyArray<JsonObject> =>
  nonBlankLines(output)
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => decodeJson(line).pipe(Option.flatMap(decodeObject), Option.toArray));

const longerText = (best: string, part: string): string => {
  if (part.length > best.length) {
    return part;
  }

  return best;
};

// Streamed parts are often cumulative: the longest wins when it already holds the rest.
const joinedParts = (parts: ReadonlyArray<string>): string => {
  const longest = parts.reduce(longerText, "");
  const holdsEveryPart = parts.every((part) => longest.includes(part));
  if (holdsEveryPart) {
    return longest;
  }

  return parts.join("\n").trim();
};

export const replyTextFromJson = (output: string): string => {
  const trimmed = output.trim();
  if (trimmed === "") {
    return "";
  }

  const wholeText = wholeReplyText(trimmed);
  if (Option.isSome(wholeText)) {
    return wholeText.value;
  }

  const events = jsonLineEvents(trimmed);
  const parts = events.flatMap((event) => partText(event).pipe(Option.toArray));
  if (parts.length > 0) {
    return joinedParts(parts);
  }

  const eventTexts = events.flatMap((event) => eventText(event).pipe(Option.toArray));
  return eventTexts.at(-1) || "";
};
