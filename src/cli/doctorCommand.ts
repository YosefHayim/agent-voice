import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Command, Options } from "@effect/cli";
import { Effect, Option, Schema } from "effect";
import { agentHookTargets } from "../agents/agentCatalog.js";
import { registeredAgents } from "../agents/hookRegistration.js";
import { loadKeyboard } from "../dictation/keyboard.js";
import { WHISPER_PACKAGE } from "../dictation/transcriber.js";
import { isWhisperModelPresent, selectWhisperModel, whisperModelPath } from "../dictation/whisperModels.js";
import { findCli, runCli } from "../refine/agentCli.js";
import { discoverProviders } from "../refine/providerModels.js";
import { readConfig } from "../settings/configFile.js";
import type { Config } from "../settings/configSchema.js";
import { readEnvironment } from "../settings/environmentVariables.js";
import { missingSupertonicFiles, supertonicFolder } from "../speech/supertonicModels.js";
import * as TerminalUI from "./TerminalUI.js";

const doctorCheckSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal("ok", "warn", "fail"),
  detail: Schema.String,
  fix: Schema.optional(Schema.String),
});

type DoctorCheck = Schema.Schema.Type<typeof doctorCheckSchema>;

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });

const problem = (request: {
  readonly name: string;
  readonly status: "warn" | "fail";
  readonly detail: string;
  readonly fix: string;
}): DoctorCheck => request;

const platformCheck = (): DoctorCheck =>
  process.platform === "darwin"
    ? ok("macOS", `${process.platform} ${process.arch}`)
    : problem({ name: "macOS", status: "fail", detail: process.platform, fix: "voxkey runs only on macOS." });

const nodeCheck = (): DoctorCheck => {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22
    ? ok("Node.js", process.versions.node)
    : problem({
        name: "Node.js",
        status: "fail",
        detail: process.versions.node,
        fix: "Install Node 22 or newer: brew install node",
      });
};

// Each native module ships a prebuilt darwin-arm64 binary; loading it proves the install is complete.
const nativeModuleCheck = (request: { readonly name: string; readonly load: () => Promise<unknown> }) =>
  Effect.tryPromise(request.load).pipe(
    Effect.as(ok(request.name, "loads")),
    Effect.catchAll((error) =>
      Effect.succeed(
        problem({ name: request.name, status: "fail", detail: String(error), fix: "Reinstall voxkey: pnpm install" }),
      ),
    ),
  );

const SYSTEM_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["osascript", "the pill, ⌘V paste, and the refine picker"],
  ["afplay", "speech playback"],
  ["pbcopy", "clipboard refine and long pastes"],
  ["pbpaste", "clipboard refine and long pastes"],
];

const toolChecks = (): ReadonlyArray<DoctorCheck> =>
  SYSTEM_TOOLS.map(([tool, purpose]) =>
    Option.isSome(findCli(tool))
      ? ok(tool, purpose)
      : problem({
          name: tool,
          status: "fail",
          detail: `missing (${purpose})`,
          fix: "It ships with macOS; check PATH.",
        }),
  );

const modelChecks = (config: Config): ReadonlyArray<DoctorCheck> => {
  const model = selectWhisperModel({ environment: readEnvironment(), config });
  const whisper = isWhisperModelPresent(model)
    ? ok("Whisper model", whisperModelPath(model))
    : problem({ name: "Whisper model", status: "warn", detail: `${model.label} not downloaded`, fix: "voxkey on" });
  const missing = missingSupertonicFiles();
  const isSpeechOff = config.speechMode === "off";
  const supertonic =
    missing.length === 0 || isSpeechOff
      ? ok("Supertonic voices", missing.length === 0 ? supertonicFolder() : "not needed (speech is off)")
      : problem({
          name: "Supertonic voices",
          status: "warn",
          detail: `${String(missing.length)} files missing`,
          fix: "voxkey on",
        });
  return [whisper, supertonic];
};

const PRIVACY_PANE = "System Settings → Privacy & Security →";

const ALLOW_TERMINAL = "allow your terminal app (or the app that runs voxkey).";

const keyboardPermissionChecks = Effect.map(
  loadKeyboard,
  (keyboard): ReadonlyArray<DoctorCheck> => [
    keyboard.accessibilityAllowed() && keyboard.postingAllowed()
      ? ok("Accessibility", "voxkey can type at the caret")
      : problem({
          name: "Accessibility",
          status: "fail",
          detail: "not allowed",
          fix: `${PRIVACY_PANE} Accessibility: ${ALLOW_TERMINAL}`,
        }),
    keyboard.inputMonitoringAllowed()
      ? ok("Input Monitoring", "voxkey can read Shift")
      : problem({
          name: "Input Monitoring",
          status: "warn",
          detail: "not allowed",
          fix: `${PRIVACY_PANE} Input Monitoring: ${ALLOW_TERMINAL}`,
        }),
  ],
).pipe(
  Effect.catchAll((error) =>
    Effect.succeed([
      problem({
        name: "Keyboard access",
        status: "fail",
        detail: error.message,
        fix: "Reinstall voxkey: pnpm install",
      }),
    ]),
  ),
);

// AVCaptureDevice through JXA: 3 is authorized, 0 not asked yet, 1 restricted, 2 denied.
const MICROPHONE_STATUS_SCRIPT =
  '$.NSBundle.bundleWithPath("/System/Library/Frameworks/AVFoundation.framework").load; $.NSClassFromString("AVCaptureDevice").authorizationStatusForMediaType("soun")';

const microphoneFix = `${PRIVACY_PANE} Microphone: ${ALLOW_TERMINAL}`;

const microphoneCheck = runCli({
  executable: "osascript",
  args: ["-l", "JavaScript", "-e", MICROPHONE_STATUS_SCRIPT],
  timeoutMs: 10_000,
}).pipe(
  Effect.map((cliRun): DoctorCheck => {
    switch (cliRun.stdout.trim()) {
      case "3":
        return ok("Microphone", "allowed");
      case "0":
        return problem({
          name: "Microphone",
          status: "warn",
          detail: "not asked yet",
          fix: "Run voxkey on and accept the prompt.",
        });
      default:
        return problem({ name: "Microphone", status: "fail", detail: "denied", fix: microphoneFix });
    }
  }),
  Effect.orElseSucceed(() =>
    problem({ name: "Microphone", status: "warn", detail: "could not ask macOS", fix: microphoneFix }),
  ),
);

const hookChecks = (): ReadonlyArray<DoctorCheck> => {
  const registered = registeredAgents().map((target) => target.agent);
  return agentHookTargets.map((target) => {
    if (registered.includes(target.agent)) {
      return ok(`${target.displayName} hook`, target.settingsFile);
    }

    return existsSync(path.join(homedir(), target.homeFolder))
      ? problem({ name: `${target.displayName} hook`, status: "warn", detail: "not registered", fix: "voxkey on" })
      : ok(`${target.displayName} hook`, "agent not installed");
  });
};

const refineChecks = (config: Config) =>
  config.refineMode === "off"
    ? Effect.succeed<ReadonlyArray<DoctorCheck>>([ok("Refine", "off")])
    : Effect.map(
        discoverProviders({ refresh: true }),
        (providers): ReadonlyArray<DoctorCheck> => [
          providers.length > 0
            ? ok("Refine providers", providers.map((provider) => provider.id).join(", "))
            : problem({
                name: "Refine providers",
                status: "fail",
                detail: "no agent CLI on PATH",
                fix: "Install one of codex, claude, gemini, grok, ollama, opencode, pi.",
              }),
          ...(config.refineSendTo === "caret" || Option.isSome(findCli("cmux"))
            ? []
            : [
                problem({
                  name: "cmux",
                  status: "fail",
                  detail: "not on PATH",
                  fix: "Install cmux or set refine-send-to caret.",
                }),
              ]),
        ],
      );

const runDoctorChecks: Effect.Effect<ReadonlyArray<DoctorCheck>> = Effect.gen(function* () {
  const savedConfig = yield* Effect.either(readConfig);
  const config = savedConfig._tag === "Right" ? savedConfig.right : undefined;
  const configCheck =
    savedConfig._tag === "Right"
      ? ok("Config", "valid")
      : problem({
          name: "Config",
          status: "fail",
          detail: savedConfig.left.message,
          fix: "Fix the file, or reset a setting: voxkey config unset <name>",
        });
  const natives = yield* Effect.forEach(
    [
      { name: "koffi (keyboard)", load: () => import("koffi") },
      { name: "PvRecorder (microphone)", load: () => import("@picovoice/pvrecorder-node") },
      { name: "whisper.node (dictation)", load: () => import(WHISPER_PACKAGE) },
      { name: "onnxruntime-node (speech)", load: () => import("onnxruntime-node") },
    ],
    nativeModuleCheck,
  );
  return [
    platformCheck(),
    nodeCheck(),
    configCheck,
    ...natives,
    ...toolChecks(),
    ...(config === undefined ? [] : modelChecks(config)),
    ...(yield* keyboardPermissionChecks),
    yield* microphoneCheck,
    ...hookChecks(),
    ...(config === undefined ? [] : yield* refineChecks(config)),
  ];
});

class DoctorChecksFailed extends Schema.TaggedError<DoctorChecksFailed>()("DoctorChecksFailed", {
  failed: Schema.Number,
}) {
  get message(): string {
    return `${String(this.failed)} check(s) failed.`;
  }
}

const jsonOption = Options.boolean("json").pipe(Options.withDescription("Print one JSON document"));

export const doctorCommand = Command.make("doctor", { json: jsonOption }, (args) =>
  Effect.gen(function* () {
    const checks = yield* runDoctorChecks;
    if (args.json) {
      yield* TerminalUI.json(checks);
    } else {
      yield* TerminalUI.intro("doctor");
      yield* Effect.forEach(checks, (check) => {
        switch (check.status) {
          case "ok":
            return TerminalUI.success(`${check.name}: ${check.detail}`);
          case "warn":
            return TerminalUI.warn(`${check.name}: ${check.detail} — ${check.fix || ""}`);
          case "fail":
            return TerminalUI.fail(`${check.name}: ${check.detail} — ${check.fix || ""}`);
        }
      });
    }
    const failed = checks.filter((check) => check.status === "fail").length;
    if (failed > 0) {
      return yield* new DoctorChecksFailed({ failed });
    }
  }),
).pipe(Command.withDescription("Check macOS, native modules, system tools, models, permissions, and agent hooks"));
