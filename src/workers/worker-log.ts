import { readStateFile } from "#src/settings/agent-voice-home.js";
import { writePrivateFile } from "#src/storage/state-files.js";

// The logs keep the full dictated and refined text, so they are private (0600 in a 0700 folder).
const appendLogLine = (fileName: "dictation.log" | "speech-worker.log", line: string): void => {
  try {
    const logPath = readStateFile(fileName);
    writePrivateFile({ path: logPath, flags: "a", contents: `${line}\n` });
  } catch {
    // Logging must never take a worker down: a full disk or a removed folder only loses this line.
  }
};

export const appendDictationLog = (line: string): void => {
  const seconds = (Date.now() / 1_000).toFixed(3);
  appendLogLine("dictation.log", `${seconds} ${line}`);
};

export const appendSpeechLog = (line: string): void => {
  const timestamp = new Date().toISOString();
  appendLogLine("speech-worker.log", `${timestamp} ${line}`);
};
