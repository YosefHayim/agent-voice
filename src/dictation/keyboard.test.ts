import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestFolder } from "../scripts/testFolder.js";

import { loadKeyboard, unicodeChunks, utf16Units } from "./keyboard.js";

const nativeKeyboard = vi.hoisted(() => ({
  pressed: new Set<number>(),
  createKeyEvent: vi.fn(),
}));

vi.mock("koffi", () => ({
  default: {
    load: () => ({
      func: (declaration: string) => {
        if (declaration.includes("CGEventSourceKeyState")) {
          return (_state: number, key: number) => nativeKeyboard.pressed.has(key);
        }
        if (declaration.includes("CGEventCreateKeyboardEvent")) {
          return nativeKeyboard.createKeyEvent;
        }
        return () => undefined;
      },
    }),
  },
}));

let keyboardHome = "";

beforeEach(() => {
  keyboardHome = makeTestFolder("keyboard");
  vi.stubEnv("HOME", keyboardHome);
  vi.stubEnv("AGENT_VOICE_HOME", keyboardHome);
  vi.stubEnv("AGENT_VOICE_CONFIG_FILE", undefined);
  nativeKeyboard.pressed.clear();
  nativeKeyboard.createKeyEvent.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(keyboardHome, { recursive: true, force: true });
});

describe("configured native hold key", () => {
  const rightOptionKeyboard = () => {
    const configPath = path.join(keyboardHome, "config.json");
    writeFileSync(configPath, '{"dictationHoldKey":"right-option"}');
    return Effect.runPromise(loadKeyboard);
  };

  it.each([0x38, 0x3c, 0x3a, 0x37, 0x3b])("does not start a Right Option hold for key %i", async (key) => {
    const keyboard = await rightOptionKeyboard();
    nativeKeyboard.pressed.add(key);
    expect(keyboard.holdDown()).toBe(false);
    expect(keyboard.otherModifiersDown()).toBe(true);
  });

  it("reads the physical Right Option key and excludes it from shortcut keys", async () => {
    const keyboard = await rightOptionKeyboard();
    nativeKeyboard.pressed.add(0x3d);
    expect(keyboard.holdDown()).toBe(true);
    expect(keyboard.otherKeysDown()).toBe(0n);
    expect(keyboard.otherModifiersDown()).toBe(false);
    nativeKeyboard.pressed.add(0x01);
    expect(keyboard.otherKeysDown()).toBe(2n);
    nativeKeyboard.pressed.delete(0x3d);
    expect(keyboard.holdDown()).toBe(false);
  });

  it("releases Right Option rather than Shift before inserting a transcript", async () => {
    const keyboard = await rightOptionKeyboard();
    keyboard.releaseHoldKey();
    expect(nativeKeyboard.createKeyEvent).toHaveBeenCalledExactlyOnceWith(undefined, 0x3d, false);
  });

  it.each([0x38, 0x3c])("keeps Shift key %i working for an existing config", async (key) => {
    const keyboard = await Effect.runPromise(loadKeyboard);
    nativeKeyboard.pressed.add(key);
    expect(keyboard.holdKey).toBe("shift");
    expect(keyboard.holdDown()).toBe(true);
    expect(keyboard.otherKeysDown()).toBe(0n);
  });
});

describe("utf16Units", () => {
  it("keeps both halves of a surrogate pair, so a dictated emoji is posted whole", () => {
    expect([...utf16Units("a😀")]).toEqual([0x61, 0xd83d, 0xde00]);
  });

  it("never splits a surrogate pair across chunks, and posts every unit of every chunk", () => {
    const text = `${"x".repeat(19)}😀 done`;
    expect(unicodeChunks(text)).toEqual(["x".repeat(19), "😀 done"]);
    expect(unicodeChunks(text).flatMap((chunk) => [...utf16Units(chunk)])).toEqual([...utf16Units(text)]);
  });
});
