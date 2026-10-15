import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Command, Options } from "@effect/cli";
import { Effect, Option, Schema } from "effect";
import { agentHookTargets } from "../agents/agentCatalog.js";
import { registeredAgents } from "../agents/hookRegistration.js";
import { type Keyboard, loadKeyboard } from "../dictation/keyboard.js";
import { WHISPER_PACKAGE } from "../dictation/transcriber.js";
import { isWhisperModelPresent, selectWhisperModel, whisperModelPath } from "../dictation/whisperModels.js";
import { findCli, runCli } from "../refine/agentCli.js";
import { type DiscoveredProvider, discoverProviders } from "../refine/providerModels.js";
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

const REINSTALL = "Reinstall voxkey: pnpm install";
const PRIVACY_PANE = "System Settings → Privacy & Security →";
const ALLOW_TERMINAL = "allow your terminal app (or the app that runs voxkey).";
const MICROPHONE_FIX = `${PRIVACY_PANE} Microphone: ${ALLOW_TERMINAL}`;

// AVCaptureDevice through JXA: 3 is authorized, 0 not asked yet, 1 restricted, 2 denied.
const MICROPHONE_STATUS_SCRIPT =
  '$.NSBundle.bundleWithPath("/System/Library/Frameworks/AVFoundation.framework").load; $.NSClassFromString("AVCaptureDevice").authorizationStatusForMediaType("soun")';

// Each native module ships a prebuilt darwin-arm64 binary; loading it proves the install is complete.
const NATIVE_MODULES = [
  { name: "koffi (keyboard)", load: () => import("koffi") },
  { name: "PvRecorder (microphone)", load: () => import("@picovoice/pvrecorder-node") },
  { name: "whisper.node (dictation)", load: () => import(WHISPER_PACKAGE) },
  { name: "onnxruntime-node (speech)", load: () => import("onnxruntime-node") },
];

const SYSTEM_TOOLS = [
  { tool: "osascript", purpose: "the pill, ⌘V paste, and the refine picker" },
  { tool: "afplay", purpose: "speech playback" },
  { tool: "pbcopy", purpose: "clipboard refine and long pastes" },
  { tool: "pbpaste", purpose: "clipboard refine and long pastes" },
];

const platformCheck = (): DoctorCheck => {
  const isMac = process.platform === "darwin";
  if (!isMac) {
    return problem({ name: "macOS", status: "fail", detail: process.platform, fix: "voxkey runs only on macOS." });
  }

  return ok("macOS", `${process.platform} ${process.arch}`);
};

const nodeCheck = (): DoctorCheck => {
  const [major] = process.versions.node.split(".");
  const isSupported = Number(major) >= 22;
  if (!isSupported) {
    const fix = "Install Node 22 or newer: brew install node";
    return problem({ name: "Node.js", status: "fail", detail: process.versions.node, fix });
  }

  return ok("Node.js", process.versions.node);
};

const nativeModuleCheck = (module: (typeof NATIVE_MODULES)[number]) =>
  Effect.tryPromise({ try: module.load, catch: String }).pipe(
    Effect.match({
      onSuccess: () => ok(module.name, "loads"),
      onFailure: (issue) => problem({ name: module.name, status: "fail", detail: issue, fix: REINSTALL }),
    }),
  );

const toolCheck = (systemTool: (typeof SYSTEM_TOOLS)[number]): DoctorCheck => {
  const toolPath = findCli(systemTool.tool);
  if (Option.isNone(toolPath)) {
    const detail = `missing (${systemTool.purpose})`;
    return problem({ name: systemTool.tool, status: "fail", detail, fix: "It ships with macOS; check PATH." });
  }

  return ok(systemTool.tool, systemTool.purpose);
};

const accessibilityCheck = (keyboard: Keyboard): DoctorCheck => {
  const canType = keyboard.accessibilityAllowed() && keyboard.postingAllowed();
  if (!canType) {
    const fix = `${PRIVACY_PANE} Accessibility: ${ALLOW_TERMINAL}`;
    return problem({ name: "Accessibility", status: "fail", detail: "not allowed", fix });
  }

  return ok("Accessibility", "voxkey can type at the caret");
};

const inputMonitoringCheck = (keyboard: Keyboard): DoctorCheck => {
  const canReadShift = keyboard.inputMonitoringAllowed();
  if (!canReadShift) {
    const fix = `${PRIVACY_PANE} Input Monitoring: ${ALLOW_TERMINAL}`;
    return problem({ name: "Input Monitoring", status: "warn", detail: "not allowed", fix });
  }

  return ok("Input Monitoring", "voxkey can read Shift");
};

const keyboardChecks = loadKeyboard.pipe(
  Effect.match({
    onSuccess: (keyboard) => [accessibilityCheck(keyboard), inputMonitoringCheck(keyboard)],
    onFailure: (error) => [problem({ name: "Keyboard access", status: "fail", detail: error.message, fix: REINSTALL })],
  }),
);

const microphoneCheckFor = (authorization: string): DoctorCheck => {
  if (authorization === "3") {
    return ok("Microphone", "allowed");
  }

  if (authorization === "0") {
    const fix = "Run voxkey on and accept the prompt.";
    return problem({ name: "Microphone", status: "warn", detail: "not asked yet", fix });
  }

  return problem({ name: "Microphone", status: "fail", detail: "denied", fix: MICROPHONE_FIX });
};

const microphoneCheck = runCli({
  executable: "osascript",
  args: ["-l", "JavaScript", "-e", MICROPHONE_STATUS_SCRIPT],
  timeoutMs: 10_000,
}).pipe(
  Effect.match({
    onSuccess: (cliRun) => {
      const authorization = cliRun.stdout.trim();
      return microphoneCheckFor(authorization);
    },
    onFailure: () =>
      problem({ name: "Microphone", status: "warn", detail: "could not ask macOS", fix: MICROPHONE_FIX }),
  }),
);

const hookChecks = (): ReadonlyArray<DoctorCheck> => {
  const home = homedir();
  const registered = registeredAgents().map((target) => target.agent);
  return agentHookTargets.map((target) => {
    const name = `${target.displayName} hook`;
    if (registered.includes(target.agent)) {
      return ok(name, target.settingsFile);
    }

    const agentFolder = path.join(home, target.homeFolder);
    if (!existsSync(agentFolder)) {
      return ok(name, "agent not installed");
    }

    return problem({ name, status: "warn", detail: "not registered", fix: "voxkey on" });
  });
};

const whisperCheck = (config: Config): DoctorCheck => {
  const environment = readEnvironment();
  const model = selectWhisperModel({ environment, config });
  if (!isWhisperModelPresent(model)) {
    return problem({
      name: "Whisper model",
      status: "warn",
      detail: `${model.label} not downloaded`,
      fix: "voxkey on",
    });
  }

  const modelPath = whisperModelPath(model);
  return ok("Whisper model", modelPath);
};

const supertonicCheck = (config: Config): DoctorCheck => {
  const missing = missingSupertonicFiles();
  if (missing.length === 0) {
    const folder = supertonicFolder();
    return ok("Supertonic voices", folder);
  }

  if (config.speechMode === "off") {
    return ok("Supertonic voices", "not needed (speech is off)");
  }

  const detail = `${String(missing.length)} files missing`;
  return problem({ name: "Supertonic voices", status: "warn", detail, fix: "voxkey on" });
};

const providersCheck = (providers: ReadonlyArray<DiscoveredProvider>): DoctorCheck => {
  if (providers.length === 0) {
    const fix = "Install one of codex, claude, gemini, grok, ollama, opencode, pi.";
    return problem({ name: "Refine providers", status: "fail", detail: "no agent CLI on PATH", fix });
  }

  const names = providers.map((provider) => provider.id).join(", ");
  return ok("Refine providers", names);
};

const cmuxCheck = (config: Config): DoctorCheck => {
  if (config.refineSendTo === "caret") {
    return ok("cmux", "not needed (refine sends to the caret)");
  }

  const cmuxPath = findCli("cmux");
  if (Option.isNone(cmuxPath)) {
    return problem({
      name: "cmux",
      status: "fail",
      detail: "not on PATH",
      fix: "Install cmux or set refine-send-to caret.",
    });
  }

  return ok("cmux", cmuxPath.value);
};

const refineChecks = (config: Config): Effect.Effect<ReadonlyArray<DoctorCheck>> => {
  if (config.refineMode === "off") {
    return Effect.succeed([ok("Refine", "off")]);
  }

  return discoverProviders({ refresh: true }).pipe(
    Effect.map((providers) => [providersCheck(providers), cmuxCheck(config)]),
  );
};

const settingChecks = (config: Config) =>
  Effect.gen(function* () {
    const refine = yield* refineChecks(config);
    return [ok("Config", "valid"), whisperCheck(config), supertonicCheck(config), ...refine];
  });

const configFailedChecks = (error: Error) => {
  const fix = "Fix the file, or reset a setting: voxkey config unset <name>";
  return Effect.succeed([problem({ name: "Config", status: "fail", detail: error.message, fix })]);
};

const runDoctorChecks = Effect.gen(function* () {
  const natives = yield* Effect.forEach(NATIVE_MODULES, nativeModuleCheck);
  const keyboard = yield* keyboardChecks;
  const microphone = yield* microphoneCheck;
  const settings = yield* readConfig.pipe(
    Effect.matchEffect({ onSuccess: settingChecks, onFailure: configFailedChecks }),
  );
  const tools = SYSTEM_TOOLS.map(toolCheck);
  const hooks = hookChecks();
  return [platformCheck(), nodeCheck(), ...natives, ...tools, ...keyboard, microphone, ...hooks, ...settings];
});

const showCheck = (check: DoctorCheck) => {
  const line = `${check.name}: ${check.detail}`;
  const lineWithFix = `${line} — ${check.fix || ""}`;
  switch (check.status) {
    case "ok":
      return TerminalUI.success(line);
    case "warn":
      return TerminalUI.warn(lineWithFix);
    case "fail":
      return TerminalUI.fail(lineWithFix);
  }
};

const showChecks = (checks: ReadonlyArray<DoctorCheck>) =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("doctor");
    yield* Effect.forEach(checks, showCheck);
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
      yield* showChecks(checks);
    }

    const failed = checks.filter((check) => check.status === "fail").length;
    if (failed > 0) {
      return yield* new DoctorChecksFailed({ failed });
    }
  }),
).pipe(Command.withDescription("Check macOS, native modules, system tools, models, permissions, and agent hooks"));
