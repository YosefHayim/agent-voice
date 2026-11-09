import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sleep } from "#src/sleep.js";
import { makeTestFolder } from "#src/testing/test-folder.js";
import { latestDevinTurn, watchDevinSession } from "./devin-watcher.js";

let home = "";

beforeEach(() => {
  home = makeTestFolder("devin");
  vi.stubEnv("AGENT_VOICE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("latestDevinTurn", () => {
  it("joins the agent messages after the latest user step and names the turn by the last agent step", () => {
    expect(
      latestDevinTurn({
        steps: [
          { step_id: "old-user", source: "user", message: "Earlier request" },
          { step_id: "old-agent", source: "agent", message: "Earlier answer" },
          { step_id: "new-user", source: "user", message: "Current request" },
          { step_id: "new-agent-1", source: "agent", message: "First part" },
          { step_id: "tool", source: "tool", message: "ignored" },
          { step_id: "new-agent-2", source: "agent", message: "Second part" },
          { step_id: "blank", source: "agent", message: "  " },
        ],
      }),
    ).toEqual({ markdown: "First part\n\nSecond part", turnId: "new-agent-2" });
  });

  it("has no turn before the agent answers", () => {
    expect(latestDevinTurn({ steps: [{ step_id: "u", source: "user", message: "hi" }] })).toEqual({
      markdown: "",
      turnId: "",
    });
  });
});

describe("watchDevinSession", () => {
  const exportFile = () => path.join(home, "session.atif.json");

  const writeTurn = (turnId: string, message: string) => {
    const atifText = JSON.stringify({
      steps: [
        { step_id: `${turnId}-user`, source: "user", message: "Question" },
        { step_id: turnId, source: "agent", message },
      ],
    });
    const atifPath = exportFile();
    writeFileSync(atifPath, atifText);
  };

  const queuedMarkdown = (): ReadonlyArray<string> => {
    const inbox = path.join(home, "inbox");
    if (!existsSync(inbox)) {
      return [];
    }

    return readdirSync(inbox).map((name) => {
      const replyPath = path.join(inbox, name);
      const replyText = readFileSync(replyPath, "utf8");
      return JSON.parse(replyText).markdown;
    });
  };

  it("keeps reading turns after a turn fails to queue, and queues the turn written as Devin exits", async () => {
    const blockedInbox = path.join(home, "inbox");
    const session = async () => {
      await sleep(100);
      writeFileSync(blockedInbox, "a file where the inbox folder should be");
      writeTurn("turn-1", "First answer");
      await sleep(1500);
      rmSync(blockedInbox);
      writeTurn("turn-2", "Second answer");
      return 0;
    };

    const exitCode = await watchDevinSession({ exportFile: exportFile(), session });

    expect(exitCode).toBe(0);
    expect(queuedMarkdown()).toEqual(["Second answer"]);
  });

  it("stops watching when Devin fails to start, even while the caller keeps running", async () => {
    const failingSession = async (): Promise<never> => {
      throw new Error("devin was not found");
    };

    await expect(watchDevinSession({ exportFile: exportFile(), session: failingSession })).rejects.toThrow(
      "devin was not found",
    );
    // A watcher still running would read this turn and queue it.
    await sleep(400);
    writeTurn("late-turn", "A turn no watcher should read");
    await sleep(1500);

    expect(queuedMarkdown()).toEqual([]);
  });
});
