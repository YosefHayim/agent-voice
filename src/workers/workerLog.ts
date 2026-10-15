/** Timestamped lines in ~/.voxkey/dictation.log: decode, refine, and typing timings for every hold. */

import { writePrivateFile } from "../files/stateFiles.js";
import { stateFile } from "../settings/voxkeyHome.js";

/**
 * The log keeps the full dictated and refined text, so it is private (0600 in a 0700 folder). Logging must never
 * take a worker down, so a failed write is dropped.
 */
export const appendDictationLog = (line: string): void => {
  try {
    writePrivateFile({
      path: stateFile("dictation.log"),
      flags: "a",
      contents: `${(Date.now() / 1_000).toFixed(3)} ${line}\n`,
    });
  } catch {
    // A full disk or a removed folder only costs this one log line.
  }
};

/** A line in ~/.voxkey/speech-worker.log (the speech worker has no terminal); private like dictation.log. */
export const appendSpeechLog = (line: string): void => {
  try {
    writePrivateFile({
      path: stateFile("speech-worker.log"),
      flags: "a",
      contents: `${new Date().toISOString()} ${line}\n`,
    });
  } catch {
    // A full disk or a removed folder only costs this one log line.
  }
};
