// Reads keys from HID state, which works without an event tap, and posts key events through CoreGraphics.

import { readConfigOrDefaults } from "#src/settings/config-file.js";
import type { Config } from "#src/settings/config-schema.js";

export interface Keyboard {
  readonly holdKey: Config["dictationHoldKey"];
  readonly holdDown: () => boolean;
  readonly otherModifiersDown: () => boolean;
  // Bit n is set while key code n is held.
  readonly otherKeysDown: () => bigint;
  readonly typeUnicode: (text: string) => void;
  readonly pressReturn: () => void;
  readonly pressCommandV: () => void;
  readonly releaseHoldKey: () => void;
  readonly accessibilityAllowed: () => boolean;
  readonly inputMonitoringAllowed: () => boolean;
  readonly postingAllowed: () => boolean;
}

const HID_SYSTEM_STATE = 1;
const COMBINED_SESSION_STATE = 0;
const HID_EVENT_TAP = 0;
const LEFT_SHIFT_KEY = 0x38;
const RIGHT_SHIFT_KEY = 0x3c;
const SHIFT_KEYS = [LEFT_SHIFT_KEY, RIGHT_SHIFT_KEY];
const LEFT_OPTION_KEY = 0x3a;
const RIGHT_OPTION_KEY = 0x3d;
const OPTION_KEY_FLAGS = new Map([
  [LEFT_OPTION_KEY, 0x0008_0020n],
  [RIGHT_OPTION_KEY, 0x0008_0040n],
]);
const MODIFIER_KEYS = [
  0x36,
  0x37,
  LEFT_SHIFT_KEY,
  LEFT_OPTION_KEY,
  0x3b,
  RIGHT_SHIFT_KEY,
  RIGHT_OPTION_KEY,
  0x3e,
  0x3f,
];
// Caps Lock reads as held while its light is on, not while it is pressed.
const CAPS_LOCK_KEY = 0x39;
const RETURN_KEY = 0x24;
const TAB_KEY = 0x30;
// The V key code, because a Unicode "v" can lose the Command modifier and type a bare v.
const V_KEY = 0x09;
const COMMAND_FLAG = 0x0010_0000n;
// CGEventKeyboardSetUnicodeString truncates longer strings.
const UNICODE_CHUNK_UNITS = 20;

// Iterating by character keeps a surrogate pair inside one chunk.
export const unicodeChunks = (text: string): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  for (const character of text) {
    const last = chunks.at(-1);
    const isFull = last === undefined || last.length + character.length > UNICODE_CHUNK_UNITS;
    if (isFull) {
      chunks.push(character);
      continue;
    }

    chunks[chunks.length - 1] = `${last}${character}`;
  }
  return chunks;
};

// Every UTF-16 code unit, so an emoji or other character outside the BMP keeps both surrogates.
export const utf16Units = (chunk: string): Uint16Array =>
  Uint16Array.from({ length: chunk.length }, (_unused, index) => chunk.charCodeAt(index));

// macOS silently drops a chunk that starts with a newline, so a zero-width space leads it.
const postableChunk = (chunk: string): string => {
  const startsWithNewline = /^[\r\n]/u.test(chunk);
  if (!startsWithNewline) {
    return chunk;
  }

  return `​${chunk}`;
};

// A failed native load is a keyboard error with the reason kept in the message.
const importKoffi = async () => {
  try {
    return await import("koffi");
  } catch (error) {
    throw new Error(`Keyboard: ${String(error)}`, { cause: error });
  }
};

export const loadKeyboard = async (): Promise<Keyboard> => {
  const config = readConfigOrDefaults();
  const holdKeys = { shift: SHIFT_KEYS, "right-option": [RIGHT_OPTION_KEY] }[config.dictationHoldKey];
  const otherKeys = Array.from({ length: 0x80 }, (_unused, key) => key).filter(
    (key) => !holdKeys.includes(key) && key !== CAPS_LOCK_KEY,
  );
  const otherModifiers = MODIFIER_KEYS.filter((key) => !holdKeys.includes(key));
  const koffiModule = await importKoffi();
  const koffi = koffiModule.default;
  const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const applicationServices = koffi.load(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
  );
  const keyState = coreGraphics.func("bool CGEventSourceKeyState(int32_t state, uint16_t key)");
  const flagsState = coreGraphics.func("uint64_t CGEventSourceFlagsState(int32_t state)");
  const createSource = coreGraphics.func("void* CGEventSourceCreate(int32_t state)");
  const createKeyEvent = coreGraphics.func("void* CGEventCreateKeyboardEvent(void* source, uint16_t key, bool down)");
  const setUnicode = coreGraphics.func(
    "void CGEventKeyboardSetUnicodeString(void* event, unsigned long length, const uint16_t* text)",
  );
  const setFlags = coreGraphics.func("void CGEventSetFlags(void* event, uint64_t flags)");
  const postEvent = coreGraphics.func("void CGEventPost(uint32_t tap, void* event)");
  const listenAllowed = coreGraphics.func("bool CGPreflightListenEventAccess()");
  const postAllowed = coreGraphics.func("bool CGPreflightPostEventAccess()");
  const release = coreFoundation.func("void CFRelease(void* object)");
  const trusted = applicationServices.func("bool AXIsProcessTrusted()");
  const source = createSource(COMBINED_SESSION_STATE);

  const isKeyDown = (key: number): boolean => {
    const optionFlags = OPTION_KEY_FLAGS.get(key);
    if (optionFlags === undefined) {
      return keyState(HID_SYSTEM_STATE, key) === true;
    }

    // Key state can alias Right Option to Left Option; device flags retain the physical side.
    const nativeFlags = flagsState(HID_SYSTEM_STATE);
    const flags = BigInt(nativeFlags);
    return (flags & optionFlags) === optionFlags;
  };

  const postKey = (request: { readonly key: number; readonly down: boolean; readonly flags: bigint }) => {
    const event = createKeyEvent(source, request.key, request.down);
    setFlags(event, request.flags);
    postEvent(HID_EVENT_TAP, event);
    release(event);
  };

  const pressKey = (key: number, flags: bigint) => {
    postKey({ key, down: true, flags });
    postKey({ key, down: false, flags });
  };

  // Flags are cleared, so a modifier still held by the hand cannot alter the typed text.
  const postUnicode = (chunk: string) => {
    const event = createKeyEvent(source, 0, true);
    const units = utf16Units(chunk);
    setUnicode(event, units.length, units);
    setFlags(event, 0n);
    postEvent(HID_EVENT_TAP, event);
    release(event);
  };

  const typeUnicode = (text: string) => {
    for (const chunk of unicodeChunks(text)) {
      if (chunk.startsWith("\t")) {
        pressKey(TAB_KEY, 0n);
      }
      const withoutTab = chunk.replace(/^\t/u, "");
      const postable = postableChunk(withoutTab);
      postUnicode(postable);
    }
  };

  return {
    holdKey: config.dictationHoldKey,
    holdDown: (): boolean => holdKeys.some(isKeyDown),
    otherModifiersDown: (): boolean => otherModifiers.some(isKeyDown),
    // Bit n is set while key code n is held.
    otherKeysDown: (): bigint => otherKeys.filter(isKeyDown).reduce((held, key) => held | (1n << BigInt(key)), 0n),
    typeUnicode,
    pressReturn: () => pressKey(RETURN_KEY, 0n),
    pressCommandV: () => pressKey(V_KEY, COMMAND_FLAG),
    releaseHoldKey: () => {
      for (const key of holdKeys) {
        postKey({ key, down: false, flags: 0n });
      }
    },
    accessibilityAllowed: (): boolean => trusted() === true,
    inputMonitoringAllowed: (): boolean => listenAllowed() === true,
    postingAllowed: (): boolean => postAllowed() === true,
  };
};
