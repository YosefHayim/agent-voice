import { type ChildProcess, spawn } from "node:child_process";

import { Option } from "effect";
import { removeIfPresent } from "../files/stateFiles.js";
import { stateFile, voxkeyHome } from "../settings/voxkeyHome.js";
import { runningPid, signalGroup, writePid } from "./workerProcesses.js";

// A bottom-centre panel that shows the dictation stage from status.json. It is a JavaScript for Automation script
// run by `osascript`, so it needs no compiler and no app bundle, and it exits when the worker it serves is gone.
const PILL_SCRIPT = `
ObjC.import("Cocoa");
ObjC.import("QuartzCore");
ObjC.import("signal");
ObjC.import("stdlib");

function run(argv) {
  var workerPid = Number(argv[0]);
  var statusPath = argv[1] + "/status.json";
  var height = 40;
  var width = 168;
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.finishLaunching;
  var screen = $.NSScreen.mainScreen.visibleFrame;
  var originY = screen.origin.y + 72;
  var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(screen.origin.x + (screen.size.width - width) / 2, originY, width, height),
    $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel,
    $.NSBackingStoreBuffered,
    false
  );
  panel.level = $.NSFloatingWindowLevel;
  panel.opaque = false;
  panel.backgroundColor = $.NSColor.clearColor;
  panel.hasShadow = false;
  panel.ignoresMouseEvents = true;
  panel.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary;

  var pill = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, width, height));
  pill.wantsLayer = true;
  pill.layer.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.09, 0.10, 0.12, 0.94).CGColor;
  pill.layer.cornerRadius = height / 2;
  pill.layer.masksToBounds = false;
  // Setting shadowColor through the bridge kills osascript; the default black at 0.25 matches 0.45 × 0.55.
  pill.layer.shadowOpacity = 0.25;
  pill.layer.shadowRadius = 12;
  panel.contentView = pill;

  var dotSize = 9;
  var dot = $.NSView.alloc.initWithFrame($.NSMakeRect(14, (height - dotSize) / 2, dotSize, dotSize));
  dot.wantsLayer = true;
  dot.layer.cornerRadius = dotSize / 2;
  dot.hidden = true;
  pill.addSubview(dot);

  var spinner = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(12, (height - 16) / 2, 16, 16));
  spinner.style = $.NSProgressIndicatorStyleSpinning;
  spinner.controlSize = $.NSControlSizeSmall;
  spinner.displayedWhenStopped = false;
  spinner.hidden = true;
  spinner.appearance = $.NSAppearance.appearanceNamed($.NSAppearanceNameDarkAqua);
  pill.addSubview(spinner);

  var font = $.NSFont.systemFontOfSizeWeight(13, $.NSFontWeightSemibold);
  var label = $.NSTextField.labelWithString($(""));
  label.font = font;
  label.textColor = $.NSColor.whiteColor;
  label.lineBreakMode = $.NSLineBreakByTruncatingHead;
  label.maximumNumberOfLines = 1;
  label.drawsBackground = false;
  label.bezeled = false;
  label.bordered = false;
  pill.addSubview(label);

  var rgb = function (red, green, blue) { return $.NSColor.colorWithSRGBRedGreenBlueAlpha(red, green, blue, 1); };
  var visible = false;
  var lastStage = "";
  var pulsing = false;

  var readStatus = function () {
    var text = $.NSString.stringWithContentsOfFileEncodingError($(statusPath), $.NSUTF8StringEncoding, null);
    if (!text || text.isNil()) { return { stage: "inactive", preview: "", detail: "" }; }
    try {
      var status = JSON.parse(text.js);
      return { stage: String(status.stage || "inactive"), preview: String(status.preview || "").trim(), detail: String(status.detail || "").trim() };
    } catch (error) {
      return { stage: "inactive", preview: "", detail: "" };
    }
  };

  var bodyText = function (status) {
    switch (status.stage) {
      case "starting": return "Connecting";
      case "listening":
        if (status.preview === "") { return "Recording"; }
        return status.preview.length > 40 ? "…" + status.preview.slice(-38) : status.preview;
      case "finishing": return "Working";
      case "refining":
        if (status.detail === "") { return "Refining…"; }
        return status.detail.length > 42 ? status.detail.slice(0, 40) + "…" : status.detail;
      case "done": return status.detail.length > 60 ? status.detail.slice(0, 58) + "…" : status.detail;
      case "unavailable": return "Mic unavailable";
      default: return "";
    }
  };

  var labelColor = function (stage) {
    switch (stage) {
      case "listening": return rgb(0.98, 0.94, 0.94);
      case "starting": return rgb(1.0, 0.90, 0.50);
      case "finishing": case "refining": return rgb(0.80, 0.88, 1.0);
      case "done": return rgb(0.80, 1.0, 0.85);
      case "unavailable": return rgb(1.0, 0.55, 0.55);
      default: return $.NSColor.whiteColor;
    }
  };

  var startPulse = function () {
    if (pulsing) { return; }
    pulsing = true;
    var pulse = $.CABasicAnimation.animationWithKeyPath($("opacity"));
    pulse.fromValue = $.NSNumber.numberWithDouble(1.0);
    pulse.toValue = $.NSNumber.numberWithDouble(0.38);
    pulse.duration = 1.2;
    pulse.autoreverses = true;
    pulse.repeatCount = 1e9;
    pulse.timingFunction = $.CAMediaTimingFunction.functionWithName($.kCAMediaTimingFunctionEaseInEaseOut);
    dot.layer.addAnimationForKey(pulse, $("pulse"));
  };

  var stopPulse = function () {
    pulsing = false;
    dot.layer.removeAnimationForKey($("pulse"));
  };

  var resize = function (body, leading) {
    var attributes = $.NSDictionary.dictionaryWithObjectForKey(font, $.NSFontAttributeName);
    var textWidth = $(body).sizeWithAttributes(attributes).width;
    var newWidth = Math.max(140, Math.min(380, leading + textWidth + 18));
    if (Math.abs(newWidth - width) > 3) {
      width = newWidth;
      panel.setFrameDisplay($.NSMakeRect(screen.origin.x + (screen.size.width - width) / 2, originY, width, height), true);
      pill.frame = $.NSMakeRect(0, 0, width, height);
    }
    label.frame = $.NSMakeRect(leading, 11, width - leading - 12, 18);
  };

  var showDot = function (red, green, blue) {
    spinner.stopAnimation(null);
    spinner.hidden = true;
    dot.hidden = false;
    dot.layer.backgroundColor = rgb(red, green, blue).CGColor;
  };

  var apply = function (stage, body) {
    switch (stage) {
      case "listening": showDot(0.92, 0.24, 0.22); startPulse(); resize(body, 32); return;
      case "starting": stopPulse(); showDot(0.98, 0.75, 0.18); resize(body, 32); return;
      case "done": stopPulse(); showDot(0.30, 0.80, 0.45); resize(body, 32); return;
      case "unavailable": stopPulse(); showDot(0.97, 0.44, 0.44); resize(body, 32); return;
      default:
        stopPulse();
        dot.hidden = true;
        spinner.hidden = false;
        spinner.startAnimation(null);
        resize(body, 34);
    }
  };

  while ($.kill(workerPid, 0) === 0) {
    var status = readStatus();
    var body = ["inactive", "idle", "ready", ""].indexOf(status.stage) >= 0 ? "" : bodyText(status);
    if (body === "") {
      if (visible) {
        stopPulse();
        spinner.stopAnimation(null);
        panel.orderOut(null);
        visible = false;
        lastStage = "";
      }
    } else {
      if (status.stage !== lastStage || !visible) {
        apply(status.stage, body);
        lastStage = status.stage;
      } else {
        resize(body, status.stage === "listening" || status.stage === "done" || status.stage === "starting" ? 32 : 34);
      }
      label.stringValue = $(body);
      label.textColor = labelColor(status.stage);
      if (!visible) {
        panel.orderFrontRegardless;
        visible = true;
      }
    }
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.08));
  }
  return "";
}
`;

export const startPill = (workerPid: number): ChildProcess => {
  stopPill();
  const child = spawn("osascript", ["-l", "JavaScript", "-", String(workerPid), voxkeyHome()], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin?.end(PILL_SCRIPT);
  if (child.pid !== undefined) {
    writePid("pill.pid", child.pid);
  }
  return child;
};

export const stopPill = (): void => {
  const pillPid = runningPid("pill.pid");
  if (Option.isSome(pillPid)) {
    signalGroup(pillPid.value, "SIGKILL");
  }
  const pidPath = stateFile("pill.pid");
  removeIfPresent(pidPath);
};
