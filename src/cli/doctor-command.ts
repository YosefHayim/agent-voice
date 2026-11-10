import { existsSync } from "node:fs";
import { listRegisteredSettingsFiles } from "#src/agents/hook-registration.js";
import { listHookSettingsFiles } from "#src/agents/hook-settings-files.js";
import { type Keyboard, loadKeyboard } from "#src/dictation/keyboard.js";
import { WHISPER_PACKAGE } from "#src/dictation/transcriber.js";
import { isWhisperModelPresent, readWhisperModelPath, selectWhisperModel } from "#src/dictation/whisper-models.js";
import { describeError } from "#src/error-message.js";
import { findCli, runCli } from "#src/refine/agent-cli.js";
import { type DiscoveredProvider, discoverProviders } from "#src/refine/provider-models.js";
import { readConfig } from "#src/settings/config-file.js";
import type { Config } from "#src/settings/config-schema.js";
import { readEnvironment } from "#src/settings/environment-variables.js";
import { listMissingSupertonicFiles, readSupertonicFolder } from "#src/speech/supertonic-models.js";
import { type CommandSpec, type ExitCode, isFlagOn } from "./command-spec.js";
import * as TerminalUI from "./terminal-ui.js";

type DoctorStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly fix?: string;
}

interface NativeModule {
  readonly name: string;
  readonly load: () => Promise<unknown>;
}

interface SystemTool {
  readonly tool: string;
  readonly purpose: string;
}

const createOkCheck = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });

const REINSTALL = "Reinstall agent-voice: pnpm install";
const PRIVACY_PANE = "System Settings → Privacy & Security →";
const ALLOW_TERMINAL = "allow your terminal app (or the app that runs agent-voice).";
const MICROPHONE_FIX = `${PRIVACY_PANE} Microphone: ${ALLOW_TERMINAL}`;

// AVCaptureDevice through JXA: 3 is authorized, 0 not asked yet, 1 restricted, 2 denied.
const MICROPHONE_STATUS_SCRIPT =
  '$.NSBundle.bundleWithPath("/System/Library/Frameworks/AVFoundation.framework").load; $.NSClassFromString("AVCaptureDevice").authorizationStatusForMediaType("soun")';

// Each native module ships a prebuilt darwin-arm64 binary; loading it proves the install is complete.
const NATIVE_MODULES: ReadonlyArray<NativeModule> = [
  { name: "koffi (keyboard)", load: () => import("koffi") },
  { name: "PvRecorder (microphone)", load: () => import("@picovoice/pvrecorder-node") },
  { name: "whisper.node (dictation)", load: () => import(WHISPER_PACKAGE) },
  { name: "onnxruntime-node (speech)", load: () => import("onnxruntime-node") },
];

const SYSTEM_TOOLS: ReadonlyArray<SystemTool> = [
  { tool: "osascript", purpose: "the pill, ⌘V paste, and the refine picker" },
  { tool: "afplay", purpose: "speech playback" },
  { tool: "pbcopy", purpose: "clipboard refine and long pastes" },
  { tool: "pbpaste", purpose: "clipboard refine and long pastes" },
];

const checkPlatform = (): DoctorCheck => {
  const isMac = process.platform === "darwin";

  const isNotMac = !isMac;
  if (isNotMac) {
    return {
      name: "macOS",
      status: "fail",
      detail: process.platform,
      fix: "agent-voice runs only on macOS.",
    };
  }

  return createOkCheck("macOS", `${process.platform} ${process.arch}`);
};

const minimumNodeMajor = 22;

const checkNode = (): DoctorCheck => {
  const [major] = process.versions.node.split(".");
  const isSupported = Number(major) >= minimumNodeMajor;

  const isTooOld = !isSupported;
  if (isTooOld) {
    const fix = "Install Node 22 or newer: brew install node";
    return { name: "Node.js", status: "fail", detail: process.versions.node, fix };
  }

  return createOkCheck("Node.js", process.versions.node);
};

const checkNativeModule = async (nativeModule: NativeModule): Promise<DoctorCheck> => {
  try {
    await nativeModule.load();
    return createOkCheck(nativeModule.name, "loads");
  } catch (error) {
    return { name: nativeModule.name, status: "fail", detail: String(error), fix: REINSTALL };
  }
};

const checkSystemTool = (systemTool: SystemTool): DoctorCheck => {
  const toolPath = findCli(systemTool.tool);

  const isToolMissing = toolPath == null;
  if (isToolMissing) {
    const detail = `missing (${systemTool.purpose})`;
    return {
      name: systemTool.tool,
      status: "fail",
      detail,
      fix: "It ships with macOS; check PATH.",
    };
  }

  return createOkCheck(systemTool.tool, systemTool.purpose);
};

const checkAccessibility = (keyboard: Keyboard): DoctorCheck => {
  const canType = keyboard.accessibilityAllowed() && keyboard.postingAllowed();

  const isTypingBlocked = !canType;
  if (isTypingBlocked) {
    const fix = `${PRIVACY_PANE} Accessibility: ${ALLOW_TERMINAL}`;
    return { name: "Accessibility", status: "fail", detail: "not allowed", fix };
  }

  return createOkCheck("Accessibility", "agent-voice can type at the caret");
};

const checkInputMonitoring = (keyboard: Keyboard): DoctorCheck => {
  const canReadKeys = keyboard.inputMonitoringAllowed();

  const isReadingBlocked = !canReadKeys;
  if (isReadingBlocked) {
    const fix = `${PRIVACY_PANE} Input Monitoring: ${ALLOW_TERMINAL}`;
    return { name: "Input Monitoring", status: "warn", detail: "not allowed", fix };
  }

  return createOkCheck("Input Monitoring", "agent-voice can read keyboard state");
};

const checkKeyboard = async (): Promise<ReadonlyArray<DoctorCheck>> => {
  try {
    const keyboard = await loadKeyboard();
    return [checkAccessibility(keyboard), checkInputMonitoring(keyboard)];
  } catch (error) {
    return [{ name: "Keyboard access", status: "fail", detail: describeError(error), fix: REINSTALL }];
  }
};

const checkMicrophoneAuthorization = (authorization: string): DoctorCheck => {
  const isAllowed = authorization === "3";
  if (isAllowed) {
    return createOkCheck("Microphone", "allowed");
  }

  const isNotAskedYet = authorization === "0";
  if (isNotAskedYet) {
    const fix = "Run agent-voice on and accept the prompt.";
    return { name: "Microphone", status: "warn", detail: "not asked yet", fix };
  }

  return { name: "Microphone", status: "fail", detail: "denied", fix: MICROPHONE_FIX };
};

const checkMicrophone = async (): Promise<DoctorCheck> => {
  try {
    const authorizationRun = await runCli({
      executable: "osascript",
      args: ["-l", "JavaScript", "-e", MICROPHONE_STATUS_SCRIPT],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    const authorization = authorizationRun.stdout.trim();
    return checkMicrophoneAuthorization(authorization);
  } catch (error) {
    const detail = `could not ask macOS: ${describeError(error)}`;
    return { name: "Microphone", status: "warn", detail, fix: MICROPHONE_FIX };
  }
};

const checkHooks = (): ReadonlyArray<DoctorCheck> => {
  const registeredFiles = listRegisteredSettingsFiles().map((settings) => settings.file);
  return listHookSettingsFiles().map((settings) => {
    const name = `${settings.displayName} hook`;

    const isRegistered = registeredFiles.includes(settings.file);
    if (isRegistered) {
      return createOkCheck(name, settings.file);
    }

    const isSettingsFolderAbsent = !existsSync(settings.folder);
    if (isSettingsFolderAbsent) {
      return createOkCheck(name, "agent not installed");
    }

    return {
      name,
      status: "warn",
      detail: `not registered in ${settings.file}`,
      fix: "agent-voice on",
    };
  });
};

const checkWhisperModel = (settings: Config): DoctorCheck => {
  const environment = readEnvironment();
  const model = selectWhisperModel({ environment, config: settings });

  const isModelMissing = !isWhisperModelPresent(model);
  if (isModelMissing) {
    return {
      name: "Whisper model",
      status: "warn",
      detail: `${model.label} not downloaded`,
      fix: "agent-voice on",
    };
  }

  const modelPath = readWhisperModelPath(model);
  return createOkCheck("Whisper model", modelPath);
};

const checkSupertonicVoices = (settings: Config): DoctorCheck => {
  const missingFiles = listMissingSupertonicFiles();

  const isEverythingPresent = missingFiles.length === 0;
  if (isEverythingPresent) {
    const folder = readSupertonicFolder();
    return createOkCheck("Supertonic voices", folder);
  }

  const isSpeechOff = settings.speechMode === "off";
  if (isSpeechOff) {
    return createOkCheck("Supertonic voices", "not needed (speech is off)");
  }

  const detail = `${String(missingFiles.length)} files missing`;
  return { name: "Supertonic voices", status: "warn", detail, fix: "agent-voice on" };
};

const checkRefineProviders = (providers: ReadonlyArray<DiscoveredProvider>): DoctorCheck => {
  const isNoProviderFound = providers.length === 0;
  if (isNoProviderFound) {
    const fix = "Install one of codex, claude, gemini, grok, ollama, opencode, pi.";
    return { name: "Refine providers", status: "fail", detail: "no agent CLI on PATH", fix };
  }

  const names = providers.map((provider) => provider.id).join(", ");
  return createOkCheck("Refine providers", names);
};

const checkCmux = (settings: Config): DoctorCheck => {
  const isSentToCaret = settings.refineSendTo === "caret";
  if (isSentToCaret) {
    return createOkCheck("cmux", "not needed (refine sends to the caret)");
  }

  const cmuxPath = findCli("cmux");

  const isCmuxMissing = cmuxPath == null;
  if (isCmuxMissing) {
    return {
      name: "cmux",
      status: "fail",
      detail: "not on PATH",
      fix: "Install cmux or set refine-send-to caret.",
    };
  }

  return createOkCheck("cmux", cmuxPath);
};

const checkRefine = async (settings: Config): Promise<ReadonlyArray<DoctorCheck>> => {
  const isRefineOff = settings.refineMode === "off";
  if (isRefineOff) {
    return [createOkCheck("Refine", "off")];
  }

  const providers = await discoverProviders({ refresh: true });
  return [checkRefineProviders(providers), checkCmux(settings)];
};

const checkSettings = async (settings: Config): Promise<ReadonlyArray<DoctorCheck>> => {
  const refineChecks = await checkRefine(settings);
  return [
    createOkCheck("Config", "valid"),
    checkWhisperModel(settings),
    checkSupertonicVoices(settings),
    ...refineChecks,
  ];
};

const createConfigFailedCheck = (error: unknown): DoctorCheck => ({
  name: "Config",
  status: "fail",
  detail: describeError(error),
  fix: "Fix the file, or reset a setting: agent-voice config unset <name>",
});

// Only reading the file can fail here, so only that call is guarded.
const runSettingChecks = async (): Promise<ReadonlyArray<DoctorCheck>> => {
  let settings: Config;
  try {
    settings = readConfig();
  } catch (error) {
    return [createConfigFailedCheck(error)];
  }

  return checkSettings(settings);
};

const runDoctorChecks = async (): Promise<ReadonlyArray<DoctorCheck>> => {
  const [nativeChecks, keyboardChecks, microphoneCheck, settingChecks] = await Promise.all([
    Promise.all(NATIVE_MODULES.map(checkNativeModule)),
    checkKeyboard(),
    checkMicrophone(),
    runSettingChecks(),
  ]);
  const toolChecks = SYSTEM_TOOLS.map(checkSystemTool);
  const hookChecks = checkHooks();
  return [
    checkPlatform(),
    checkNode(),
    ...nativeChecks,
    ...toolChecks,
    ...keyboardChecks,
    microphoneCheck,
    ...hookChecks,
    ...settingChecks,
  ];
};

const printCheck = (check: DoctorCheck): void => {
  const checkLine = `${check.name}: ${check.detail}`;
  const checkLineWithFix = `${checkLine} — ${check.fix ?? ""}`;
  switch (check.status) {
    case "ok":
      TerminalUI.printSuccess(checkLine);
      return;
    case "warn":
      TerminalUI.printWarning(checkLineWithFix);
      return;
    case "fail":
      TerminalUI.printFailure(checkLineWithFix);
      return;
  }
};

const printChecks = (checks: ReadonlyArray<DoctorCheck>): void => {
  TerminalUI.printIntro("doctor");
  for (const check of checks) {
    printCheck(check);
  }
};

export const doctorCommand: CommandSpec = {
  name: "doctor",
  description: "Check macOS, native modules, system tools, models, permissions, and agent hooks",
  flags: {
    json: { kind: "boolean", description: "Print one JSON document" },
  },
  positionals: [],
  run: async (parsedCommand): Promise<ExitCode> => {
    const checks = await runDoctorChecks();

    const isJsonWanted = isFlagOn(parsedCommand, "json");
    if (isJsonWanted) {
      TerminalUI.printDocument(checks);
    } else {
      printChecks(checks);
    }

    const failedCount = checks.filter((check) => check.status === "fail").length;

    const isNoCheckFailed = failedCount <= 0;
    if (isNoCheckFailed) {
      return 0;
    }

    TerminalUI.printError(`${String(failedCount)} check(s) failed.`);
    return 1;
  },
};
