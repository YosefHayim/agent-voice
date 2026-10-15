import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";
import { latestDevinTurn, watchDevinSession } from "./devinWatcher.js";

let home = "";

beforeEach(() => {
  home = makeTestFolder("devin");
  vi.stubEnv("VOXKEY_HOME", home);
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
    const session = Effect.gen(function* () {
      yield* Effect.sleep("100 millis");
      writeFileSync(blockedInbox, "a file where the inbox folder should be");
      writeTurn("turn-1", "First answer");
      yield* Effect.sleep("1500 millis");
      rmSync(blockedInbox);
      writeTurn("turn-2", "Second answer");
      return 0;
    });

    const watchedSession = watchDevinSession({ exportFile: exportFile(), session });

    expect(await Effect.runPromise(watchedSession)).toBe(0);
    expect(queuedMarkdown()).toEqual(["Second answer"]);
  });

  it("stops watching when Devin fails to start, even while the caller keeps running", async () => {
    const program = Effect.gen(function* () {
      const failure = yield* watchDevinSession({
        exportFile: exportFile(),
        session: Effect.fail("devin was not found" as const),
      }).pipe(Effect.flip);
      // A watcher left running would by now have read the empty export, so it would take this turn for a new one.
      yield* Effect.sleep("400 millis");
      writeTurn("late-turn", "A turn no watcher should read");
      yield* Effect.sleep("1500 millis");
      return failure;
    });

    expect(await Effect.runPromise(program)).toBe("devin was not found");
    expect(queuedMarkdown()).toEqual([]);
  });
});
