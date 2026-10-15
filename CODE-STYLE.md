# voxkey code style

This file is the prescriptive single source of truth for how code in this repository is written. It uses the rule-card format: one card per rule, machine-checked by `src/scripts/checkRuleCards.ts`.

A rule is not done until its verifier gates the same change, when the rule can be checked mechanically.

## How to read a rule

Every rule is one card with the same five slots in the same order. A card that drifts fails `pnpm verify`:

| Slot | Content |
| --- | --- |
| `###` heading | Short human name |
| Metadata line | `[rule:<id>] · verify: <command or `judgment`>` |
| Assertion | **Exactly one sentence**, phrased so a diff either satisfies it or does not |
| `ts` block | A `// ✓` case and a `// ✗` case |
| `Why:` | One line of rationale |

`judgment` means no detector exists and a reviewer owns the rule; it does not mean "unimportant".

## Rules

### No generic bucket files
[rule:path.no-generic-bucket] · verify: `pnpm style`

Every authored file and directory name states the domain job it performs.

```ts
// ✓ src/speech/inbox.ts
export const claimNextReply = (config: Config) => Effect.void;

// ✗ also index, types, utils, helpers, common, shared, misc, constants, models, base, core
// src/speech/utils.ts
export const doStuff = (input: unknown) => input;
```

Why: bucket files collect unrelated code forever, because nothing in the name says what does not belong.

### Authored path casing
[rule:path.source-directory-case] · verify: `pnpm style`

Authored source directories use camelCase.

```ts
// ✓ src/agents/hookSettings.ts
export const agentId = "claude-code";

// ✗ src/Agents/hookSettings.ts or src/agent_hooks/hookSettings.ts
```

Why: public IDs stay kebab-case data; directory names follow one casing so the tree reads the same everywhere.

### No wrapper layers
[rule:architecture.no-wrapper-layer] · verify: judgment

A repository-owned layer exists only when it owns policy the library it wraps does not.

```ts
// ✓ owns real policy: wait for Shift to be up before typing so it cannot capitalize the text
export const typeAtCaret = (text: string) => waitForShiftUp(900).pipe(Effect.zipRight(postUnicodeText(text)));

// ✗ a pass-through that only renames a koffi call
export const keyState = (key: number) => cgEventSourceKeyState(1, key);
```

Why: a wrapper that owns no policy adds a name to learn, a file to open, and nothing else.

### Separate policy from mechanism
[rule:architecture.policy-mechanism] · verify: judgment

Decisions are pure functions, and microphone, keyboard, process, file, and model mechanisms live apart from them.

```ts
// ✓ the hold decision is pure; the 8 ms poller only feeds it events
const [nextState, action] = holdTransition(state, "shiftUp");

// ✗ the decision buried inside the polling loop
setInterval(() => (shiftDown() && Date.now() - downAt > 300 ? startRecording() : cancelRecording()), 8);
```

Why: decisions get fast unit tests and mechanisms can change hardware APIs without touching the rules.

### Abstractions must earn their name
[rule:architecture.earned-abstraction] · verify: judgment

An abstraction exists only when it names a domain concept, owns a side-effect boundary, or serves a second caller.

```ts
// ✓ stable external boundary used by every provider
const runCli = (invocation: CliInvocation) => Effect.async<CliExit>(() => {});

// ✗ pass-through used once
const providerName = (provider: Provider) => provider.id;
```

Why: a one-use rename increases indirection without reducing change cost.

### No speculative robustness
[rule:architecture.no-speculation] · verify: judgment

Fallbacks and recovery paths exist only at a named trust boundary with a real failure requirement.

```ts
// ✓ the agent Stop hook fails open at its process boundary, because it must never block the agent
replyHook.pipe(Effect.catchAllCause(() => Effect.void));

// ✗ silent fallback chain for states the Schema excludes
const voice = configVoice || envVoice || legacyVoice || "F4";
```

Why: fake robustness hides broken contracts and multiplies states nobody tests.

### Arrow constants
[rule:function.arrow-only] · verify: `pnpm style`

Named functions are arrow functions, never function declarations, function expressions, or object methods.

```ts
// ✓
const decodeConfig = (input: unknown) => Schema.decodeUnknown(configSchema)(input);

// ✗ hoisted declaration, function expression, or object method
function decodeConfig(input: unknown) {
  return Schema.decodeUnknown(configSchema)(input);
}
```

Why: one declaration form, and files that read from primitives into orchestration without relying on hoisting.

### Effect generator exception
[rule:function.effect-generator] · verify: `pnpm style`

The only generator is an anonymous callback passed directly to `Effect.gen`.

```ts
// ✓
export const readConfig = Effect.gen(function* () {
  return yield* decodeConfigFile(configFilePath());
});

// ✗ named, or assigned and forwarded
const readConfigSteps = function* () {};
export const readConfig = Effect.gen(readConfigSteps);
```

Why: `Effect.gen` is the one place a generator earns its keyword.

### Cohesive inputs
[rule:function.input-shape] · verify: `pnpm style`

A function takes one cohesive input, or two only as a natural pair.

```ts
// ✓ a natural pair, and a named request for anything wider
export const holdTransition = (state: HoldState, event: HoldEvent) => [state, "none"] as const;
export const refinePrompt = (request: RefineRequest) => Effect.void;

// ✗ three positionals, a rest parameter, or a positional boolean flag
export const refinePrompt = (text: string, provider: string, model: string) => Effect.void;
export const speak = (text: string, immediately: boolean) => Effect.void;
```

Why: a named request survives new fields, and a boolean at a call site tells the reader nothing.

### One visible job
[rule:function.one-job] · verify: judgment

A function performs one job its name fully describes.

```ts
// ✓ the name covers the whole body
const queueReply = (reply: QueuedReply) => writeJsonAtomically({ path: inboxFile(reply), value: reply });

// ✗ decode + queue + start workers + print under one name
const handleStop = (input: string) => Effect.void;
```

Why: when the name stops covering the body, every reader has to read the body to learn what the call does.

### Blank lines between functions
[rule:function.blank-line] · verify: `pnpm style`

Adjacent function declarations are separated by a blank line, and Biome collapses any extra ones.

```ts
// ✓
const isSpeaking = () => speakingFiles().length > 0;

const isMuted = (config: Config) => config.speechMuted;

// ✗
const isSpeaking = () => speakingFiles().length > 0;
const isMuted = (config: Config) => config.speechMuted;
```

Why: the blank line is the boundary between units.

### Maximum nesting
[rule:function.nesting] · verify: `pnpm style`

Control flow nests at most two levels deep.

```ts
// ✓ guard clause keeps the body flat
const firstVoiced = (frames: ReadonlyArray<boolean>) => {
  const index = frames.indexOf(true);
  if (index < 0) {
    return Option.none();
  }

  return Option.some(index);
};

// ✗ third level
for (const reply of replies) {
  if (reply.origin.kind === "cmux") {
    if (focused) {
      speak(reply);
    }
  }
}
```

Why: past two levels the reader has to hold the accumulated conditions in their head.

### Guards protect prerequisites
[rule:control.guard-else] · verify: judgment

Failed prerequisites return early, and `else` appears only when both branches are real alternatives.

```ts
// ✓
if (config.speechMode === "off") {
  return;
}
yield* queueReply(reply);

// ✗ else after a terminal branch
if (config.speechMode === "off") return;
else yield* queueReply(reply);
```

Why: guards flatten exceptional paths.

### Closed variants are exhaustive
[rule:control.closed-switch] · verify: judgment

Closed domain variants use an exhaustive switch.

```ts
// ✓
switch (config.refineSendTo) {
  case "caret": return typeAtCaret(text);
  case "cmux-new": return sendToNewWorkspace(text);
  case "cmux-resume": return sendToFocusedSurface(text);
}

// ✗ repeated string conditions for a closed variant
if (config.refineSendTo === "caret") return typeAtCaret(text);
return sendToCmux(text);
```

Why: exhaustive control flow makes a newly added variant fail to compile.

### No ternaries
[rule:control.no-ternary] · verify: `pnpm style`

Name the condition in a boolean such as `isFinishedTurn`, then branch with `if` and an early return instead of `? :`.

```ts
// ✓
const isFinishedTurn = input.reason === "end_turn";
if (!isFinishedTurn) {
  return Option.none();
}

return Option.some(input.lastAssistantMessage);

// ✗
return input.reason === "end_turn" ? Option.some(input.lastAssistantMessage) : Option.none();
```

Why: a named condition reads as a sentence, and each branch is its own line to read and to stop on.

### Tagged errors are the only classes
[rule:class.tagged-error-only] · verify: `pnpm style`

The only authored class directly extends `Schema.TaggedError`.

```ts
// ✓
export class ModelDownloadError extends Schema.TaggedError<ModelDownloadError>()("ModelDownloadError", {
  url: Schema.String,
}) {}

// ✗
export class WorkerManager {
  start() {}
}
```

Why: failures need a tag Effect can match on; everything else is data, schemas, and arrow functions.

### Failures carry domain facts
[rule:failure.domain-fields] · verify: judgment

Tagged failures carry domain fields and leave user-facing wording to the CLI.

```ts
// ✓
return yield* new WorkerStartError({ worker: "dictation", logFile });

// ✗
return yield* Effect.fail(new Error("Sorry, it did not work!"));
```

Why: structured facts serve text and JSON output alike.

### One CLI failure translation
[rule:failure.cli-translation] · verify: judgment

The CLI translates tagged failures once, in `src/cli/main.ts`, mapping usage errors to exit 2 and operation errors to exit 1.

```ts
// ✓ src/cli/main.ts owns the terminal edge
program.pipe(Effect.catchAll(showCliFailure));

// ✗ a command swallows a failure and exits 0
turnOn.pipe(Effect.catchAll((error) => TerminalUI.fail(String(error))));
```

Why: one terminal edge prevents contradictory messages and false zero exit codes.

### Indexed-access proof
[rule:comment.index-proof] · verify: `pnpm style`

Every indexed non-null access carries a bounds proof comment directly above it.

```ts
// ✓
// The loop bound proves the index is inside samples.
total += samples[index]! * samples[index]!;

// ✗ unproven
total += samples[index]!;
```

Why: `!` on an index is a runtime claim the type system cannot see, so it is written down where it is made.

### Comments explain hidden intent
[rule:comment.hidden-intent-only] · verify: judgment

Comments explain a constraint or decision that names, types, and structure cannot express.

```ts
// ✓ Mark the reply seen before playback, so a restart during speech never replays it.
yield* rememberSpoken(reply);

// ✗ Remember the reply.
yield* rememberSpoken(reply);
```

Why: speech repeats syntax and drifts, while a hidden constraint stops a future edit from breaking an invariant.

### No doc comments
[rule:comment.no-doc-block] · verify: `pnpm style`

Code has no `/** */` doc comments; the name says what a thing is, and a `//` line says a hidden reason.

```ts
// ✓
// A Claude Code Stop hook that exits 2 blocks the agent, so bad arguments are a silent no-op.
export const runReplyHookFromArguments = (args: ReadonlyArray<string>): Effect.Effect<void> => {

// ✗
/** Runs the reply hook from its arguments. */
export const runReplyHookFromArguments = (args: ReadonlyArray<string>): Effect.Effect<void> => {
```

Why: voxkey publishes no API docs, so a doc block only repeats the name and drifts from the code.

### Schema owns runtime objects
[rule:type.schema-owned-runtime] · verify: `pnpm style`

Data crossing a process, file, CLI, environment, agent-hook, or catalog boundary is an Effect Schema first, with its TypeScript type derived.

```ts
// ✓ src/speech/inbox.ts
export const queuedReplySchema = Schema.Struct({
  markdown: Schema.String.annotations({ description: "Complete agent reply as Markdown." }),
  source: Schema.String.annotations({ description: "Agent ID that produced the reply." }),
  receivedAt: Schema.Number.annotations({ description: "Unix time in seconds." }),
});

export type QueuedReply = Schema.Schema.Type<typeof queuedReplySchema>;

// ✗ a handwritten type beside a hand-rolled reader
export type QueuedReply = { markdown: string; source: string; receivedAt: number };
```

Why: one executable definition cannot drift from itself, and decoding, defaults, and descriptions stay attached to the field they govern.

### Model valid states directly
[rule:type.valid-states] · verify: judgment

Domain types encode valid states directly instead of combining flags.

```ts
// ✓
const replyOriginSchema = Schema.Union(terminalOriginSchema, cmuxOriginSchema);

// ✗ contradictory combinations are representable
const replyOriginSchema = Schema.Struct({ isCmux: Schema.Boolean, surfaceId: Schema.optional(Schema.String) });
```

Why: a type that cannot represent a contradiction deletes checks from every consumer.

### Schema owns serialization
[rule:type.schema-serialization] · verify: judgment

The owning Schema defines decoding, encoding, and defaults for its boundary value.

```ts
// ✓
const decodeConfig = Schema.decodeUnknown(configSchema);
const encodeConfig = Schema.encode(configSchema);

// ✗ a second default table beside the Schema
const CONFIG_DEFAULTS = { speechVoice: "F4" };
```

Why: parallel serializers and default tables drift from the contract they protect.

### No unsafe any
[rule:type.no-unsafe-any] · verify: `pnpm style`

Authored types use `unknown` at trust boundaries and never write `any`.

```ts
// ✓
const decodeHookInput = (input: unknown) => Schema.decodeUnknown(hookInputSchema)(input);

// ✗
const decodeHookInput = (input: any) => input;
```

Why: `any` silently spreads missing proof through every caller.

### Decode once at a boundary
[rule:type.decode-once] · verify: `pnpm style`

Values from outside the process are decoded by their Schema, never read with hand-rolled `typeof` checks or `isRecord` helpers.

```ts
// ✓
const reply = Schema.decodeUnknownOption(Schema.NonEmptyTrimmedString)(hookInput.last_assistant_message);

// ✗
const reply = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
```

Why: a hand-rolled reader duplicates the boundary contract and makes valid values look untrusted forever.

### No nullish fallback operator
[rule:syntax.no-nullish] · verify: `pnpm style`

Authored TypeScript never uses the nullish coalescing operator.

```ts
// ✓ the boundary Schema supplies the default
const config = yield* readConfig;

// ✗
const voice = flags.voice ?? config.speechVoice ?? "F4";
```

Why: one decoded boundary owns absence and defaults instead of fallback syntax spread through the logic.

### No nested calls
[rule:syntax.no-nested-call] · verify: `pnpm style`

A call never takes another call as an argument; name the inner value on its own line, except inside `expect(...)`, `.pipe(...)`, and a Schema built from Schemas.

```ts
// ✓
const transcript = readFileSync(transcriptPath, "utf8");
return replyFromTranscript(transcript);

// ✗
return replyFromTranscript(readFileSync(transcriptPath, "utf8"));
```

Why: each named step can be read, logged, and stopped on by itself.

### Interfaces only when the mechanism requires them
[rule:type.no-interface] · verify: `pnpm style`

Interfaces appear only in declaration files for an external contract.

```ts
// ✓
type HoldTimer = { readonly state: HoldState; readonly generation: number };

// ✗
interface HoldTimer {
  state: HoldState;
}
```

Why: product-owned runtime shapes belong to Schema and internal static shapes use `type`.

### No enums
[rule:type.no-enum] · verify: `pnpm style`

Unions derived from schema literals replace enums.

```ts
// ✓
export const holdStateSchema = Schema.Literal("idle", "waiting", "shortcut", "listening");

// ✗
enum HoldState {
  Idle,
  Waiting,
}
```

Why: an enum invents a runtime value that no boundary can decode.

### No conditional or infer machinery
[rule:type.no-conditional] · verify: `pnpm style`

Types are derived from schemas, never computed with conditional or `infer` machinery.

```ts
// ✓
export type Config = Schema.Schema.Type<typeof configSchema>;

// ✗
type ElementOf<Value> = Value extends ReadonlyArray<infer Item> ? Item : Value;
```

Why: when the schema is the source of truth there is nothing to recover.

### Assertions need local proof
[rule:type.no-assertion] · verify: `pnpm style`

Unknown input is decoded or narrowed, while `as const` and `satisfies` remain allowed.

```ts
// ✓
const voices = ["F1", "F2"] as const;

// ✗
const config = input as Config;
const pid = maybePid!;
```

Why: assertions must keep compiler evidence rather than replace runtime validation.

### No suppression directives
[rule:type.no-suppression] · verify: `pnpm style`

A suppression is allowed only for a reasoned negative type test or a narrow external defect linked to an issue.

```ts
// ✓ in a test
// @ts-expect-error Agent IDs are a closed list.
const agent: AgentId = "cursor";

// ✗
// @ts-expect-error close enough
const config: Config = input;
```

Why: an unexplained suppression turns a caught error into an invisible one.

### No passive barrels
[rule:module.no-passive-barrel] · verify: `pnpm style`

Authored modules export their own capability and never exist only to re-export siblings.

```ts
// ✓
import { claimNextReply } from "../speech/inbox.js";

// ✗ src/speech/index.ts
export * from "./inbox.js";
```

Why: a passive barrel adds a path and an export surface without owning behavior.

### Domain-specific names
[rule:name.domain-specific] · verify: `pnpm style`

Every authored identifier names its domain job and contains none of the forbidden generic tokens.

```ts
// ✓
const transcript = yield* transcribe(clip);

// ✗ forbidden tokens: data, raw, result(s), response, payload, body, info, temp/tmp, final, outcome
const result = decode(raw);
```

Why: a generic token sends the reader to the body; protocol spellings such as `last_assistant_message` are decoded once into domain names.

### Never mutate inputs
[rule:mutation.no-input] · verify: `pnpm style`

A function never mutates a value it received.

```ts
// ✓ mutate only what the function created (a closure's own state)
const makeClipBuffer = () => {
  const chunks: Array<Int16Array> = [];
  return { append: (frame: Int16Array) => chunks.push(frame) };
};

// ✗
const append = (chunks: Array<Int16Array>, frame: Int16Array) => chunks.push(frame);
```

Why: every input is borrowed, and the caller cannot see a callee rewrite it.

### Collection syntax states intent
[rule:collection.intent] · verify: judgment

Collections use direct transformations, explicit loops for sequential or early-exit work, and `reduce` only for a real aggregation.

```ts
// ✓
const energy = frames.map(rootMeanSquare);
const total = samples.reduce((sum, sample) => sum + sample * sample, 0);

// ✗ building a collection with reduce
const byId = replies.reduce((map, reply) => ({ ...map, [reply.id]: reply }), {});
```

Why: syntax should show whether the work transforms, filters, aggregates, or stops early.

### No Promise.all in the application
[rule:effect.no-promise-all] · verify: `pnpm style`

Application code composes concurrency with Effect operators, never `Promise.all`.

```ts
// ✓
const providers = yield* Effect.forEach(present, describeProvider, { concurrency: 8 });

// ✗
const providers = yield* Effect.promise(() => Promise.all(present.map(describeProvider)));
```

Why: `Promise.all` leaves Effect, so interruption and typed failures stop applying.

### One runtime edge
[rule:effect.runtime-edge] · verify: `pnpm style`

Only `src/cli/main.ts` and colocated tests start the Effect runtime.

```ts
// ✓ src/cli/main.ts
NodeRuntime.runMain(program);

// ✗ a capability starting its own runtime
export const speak = (text: string) => Effect.runPromise(speakMarkdown(text));
```

Why: capabilities that return Effect values stay composable and interruptible.

### Official services directly
[rule:effect.official-services] · verify: judgment

Capabilities call Effect, Node, and native module APIs directly instead of through forwarding services.

```ts
// ✓
const recorder = new PvRecorder(FRAME_SAMPLES, DEFAULT_DEVICE);

// ✗
const microphoneService = { open: (frames: number) => new PvRecorder(frames, -1) };
```

Why: the library is already the abstraction; a second one hides which library is in use.

### Native modules load lazily
[rule:native.lazy-load] · verify: judgment

A native addon (`koffi`, `@picovoice/pvrecorder-node`, `@fugood/whisper.node`, `onnxruntime-node`) is imported only inside the command path that needs it.

```ts
// ✓ the Stop hook never pays for loading Whisper or ONNX Runtime
const loadWhisper = Effect.tryPromise(() => import("@fugood/whisper.node"));

// ✗ a top-level import pulled into every command, including `voxkey reply`
import { initWhisper } from "@fugood/whisper.node";
```

Why: `voxkey reply` runs at the end of every agent turn and must stay fast.

### The reply hook fails open
[rule:hook.fail-open] · verify: `pnpm test`

The reply hook (`voxkey reply`) exits 0 and prints nothing whatever its input or failure.

```ts
// ✓
export const replyHook = queueAgentReply.pipe(Effect.catchAllCause(() => Effect.void));

// ✗ a failure surfaces to the agent and can block its turn
export const replyHook = queueAgentReply;
```

Why: a speech bug must never block or confuse the coding agent.

### One owned hook entry
[rule:hook.one-entry] · verify: `pnpm test`

voxkey owns exactly one Stop entry per agent settings file, finds it by its command, and edits only its own bytes.

```ts
// ✓ text edits at jsonc-parser offsets, verified by re-parsing before the write
const edited = addReplyHook({ source, command });

// ✗ parse, mutate, and re-serialize the whole user file
writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(source), hooks }, null, 2));
```

Why: agent settings files belong to the user; comments, order, and spacing must survive `voxkey on` and `voxkey off`.

### Configuration precedence is combined once
[rule:config.precedence] · verify: judgment

Each setting is resolved once, from the CLI flag, then the environment variable, then the config file, then the Schema default.

```ts
// ✓
const model = selectDictationModel({ environment, config });

// ✗ every caller rebuilds its own fallback chain
const model = process.env.VOXKEY_DICTATION_MODEL || config.dictationLanguage || "turbo-q5";
```

Why: distributed precedence makes the real source of a setting unknowable.

### Child processes use argument arrays
[rule:process.argv] · verify: judgment

Child processes receive an executable and an argument array, never shell-interpolated text.

```ts
// ✓
spawn("codex", ["exec", "-m", model, "--ephemeral", prompt]);

// ✗
exec(`codex exec -m ${model} "${prompt}"`);
```

Why: argument arrays keep quoting intact and remove command injection.

### TerminalUI owns application output
[rule:presentation.terminal-ui] · verify: `pnpm style`

Application code returns structured values and leaves terminal output to `src/cli/TerminalUI.ts`.

```ts
// ✓
export const readWorkerStatus = Effect.sync(() => decodeStatus(readStatusFile()));

// ✗
export const readWorkerStatus = Effect.sync(() => console.log(readStatusFile()));
```

Why: one presentation owner is what makes JSON output and quiet worker processes possible. Workers write to their own log files.

### Tests prove public behavior
[rule:test.behavior] · verify: judgment

Tests are colocated, name a scenario, exercise public behavior in real temporary folders, and mock only external systems.

```ts
// ✓
it("restores the settings bytes exactly after voxkey off", () => {});

// ✗
it("works", () => expect(helper()).toBe(true));
```

Why: behavior tests survive internal refactors.

### Maintained scripts are tool-first
[rule:tooling.tool-first] · verify: judgment

Maintained scripts exist only for repository-specific work an installed tool cannot do directly.

```ts
// ✓ src/scripts/checkCodeStyle.ts — rules no off-the-shelf linter knows

// ✗ src/scripts/lint.ts that only forwards to Biome
```

Why: direct tools keep commands recognizable.

### Dependencies are exact
[rule:tooling.exact-dependencies] · verify: `pnpm install --frozen-lockfile`

Runtime and development dependencies use exact versions with one lockfile.

```ts
// ✓ "koffi": "3.3.2"
const exactVersion = "3.3.2";

// ✗ "koffi": "^3.3.2"
const floatingVersion = "^3.3.2";
```

Why: local, CI, and published builds resolve the same toolchain.

### Git hooks only verify
[rule:tooling.git-hooks-verify] · verify: judgment

Git hooks run deterministic checks and never rewrite or stage files.

```ts
// ✓ .husky/pre-commit
const preCommitCommand = "pnpm verify";

// ✗
const preCommitCommand = "biome check --write . && git add -A";
```

Why: a commit hook must not silently change the commit the author reviewed.

### Feature branch for product work
[rule:git.feature-branch] · verify: judgment

Product changes land from a named topic branch, never as direct commits on the default branch.

```ts
// ✓ git switch -c feat/hebrew-preview
// ✗ git commit on main
```

Why: keeps main releasable and reviews scoped.

## Canonical example

The hold-to-dictate path is the litmus test for policy and mechanism: `src/dictation/holdKey.ts` is a pure transition table, every state and event spelled out, with unit tests; `src/dictation/keyboard.ts` owns the koffi calls; `src/dictation/dictationWorker.ts` polls Shift every 8 ms, feeds events to the table, and turns actions into microphone and queue calls.

```ts
// src/dictation/holdKey.ts
const holdSteps: Record<HoldState, Record<HoldEvent, HoldStep>> = {
  idle: {
    shiftDown: ["waiting", "schedule"],
    shiftUp: ["idle", "none"],
    otherDown: ["idle", "none"],
    holdElapsed: ["idle", "none"],
  },
  waiting: {
    shiftDown: ["waiting", "none"],
    shiftUp: ["idle", "tap"],
    otherDown: ["shortcut", "cancel"],
    holdElapsed: ["listening", "start"],
  },
  // ...shortcut and listening spell out their four events the same way
};

export const holdTransition = (state: HoldState, event: HoldEvent): HoldStep => holdSteps[state][event];
```

## Golden path — adding a feature

1. Put the pure decision in the capability folder that owns it (`dictation`, `speech`, `refine`, `agents`, …) with a colocated test.
2. Put the mechanism (native call, process, file) beside it and load native modules lazily.
3. Add any setting to `src/settings/configSchema.ts` with a title and description; add any environment variable to `src/settings/environmentVariables.ts` and `.env.example`.
4. Add or extend one command file in `src/cli/`, rendering through `TerminalUI`.
5. Update README, and its hand checks when the user must check the feature by hand.
6. Run `pnpm verify`.

## Exemplars

- `src/dictation/holdKey.ts` — a pure decision with a table of unit cases.
- `src/agents/hookSettings.ts` — byte-preserving edits of a user file, verified before the write.
- `src/speech/inbox.ts` — Schema-owned files and pure ordering rules.
- `src/cli/TerminalUI.ts` — the single presentation owner.

## Never

- `index`, `types`, `utils`, `helpers`, `common`, `shared`, `misc`, `constants`, `models`, `base`, or `core` as file names · [rule:path.no-generic-bucket]
- `typeof x === "string"` readers or `isRecord` helpers for outside data · [rule:type.decode-once]
- A handwritten object type next to a hand-rolled reader · [rule:type.schema-owned-runtime]
- `data`, `raw`, `result`, `response`, `payload`, `body`, `info`, `temp`, `tmp`, `final`, or `outcome` in identifiers · [rule:name.domain-specific]
- `??` · [rule:syntax.no-nullish]
- `? :` · [rule:control.no-ternary]
- `f(g(x))` · [rule:syntax.no-nested-call]
- `/** */` doc comments · [rule:comment.no-doc-block]
- `as`, `any`, or `!` used to get past a boundary · [rule:type.no-assertion]
- `console.log` in application code · [rule:presentation.terminal-ui]
- A top-level import of a native addon in a module the reply hook loads · [rule:native.lazy-load]
- A reply hook that can exit non-zero or print · [rule:hook.fail-open]
- Re-serializing an agent's settings file · [rule:hook.one-entry]

## Formatting and verification

Biome owns formatting (2 spaces, double quotes, semicolons, trailing commas, 120 columns) and import order. `pnpm style` owns the repository rules above that say `pnpm style`.

| Command | Covers |
| --- | --- |
| `pnpm verify` | Biome → typecheck → code-style contract → style-guide contract → tests → build |
| `pnpm style` | AST, path, and naming rules over every maintained file |
| `pnpm style:guide .` | Rule-card format of this file |
