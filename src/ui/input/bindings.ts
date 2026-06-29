import type { Button } from "../../gb";
import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";

/**
 * User-configurable input bindings.
 *
 * The eight `GB_BUTTONS` (D-pad + A / B / Start / Select) are shared
 * across both engines — the Game Boy Advance joypad has the same
 * eight plus two shoulders. The GBA-only shoulders L / R have their
 * own `ShoulderKeyBindings` / `ShoulderGamepadBindings` records below
 * so existing GB users' saved bindings aren't perturbed by the GBA
 * addition. Two parallel mapping styles for both groups: keyboard
 * (`KeyboardEvent.code` strings) and gamepad (button index, or axis
 * index + sign for D-Pad-on-stick layouts).
 *
 * Defaults match the historical hard-coded bindings:
 *  - keyboard: arrow keys + Z/X + Enter/Right-Shift, with shoulders
 *    on Q/W (GBA carts only).
 *  - gamepad: the W3C "standard" mapping (face buttons 0/1, Back 8, Start 9,
 *    D-Pad 12-15) which Chrome/Edge apply to most modern controllers,
 *    with shoulders on the standard L1/R1 indices 4/5.
 *
 * Persisted to localStorage. Missing keys fall back to defaults so adding a
 * new binding in a future version doesn't break existing users' overrides.
 */

export const GB_BUTTONS: readonly Button[] = ["up", "down", "left", "right", "a", "b", "start", "select"];

/** Rebindable keyboard shortcuts for shell-level actions. Slot save /
 *  load (0-9 and Shift+0-9) stay positional and aren't included — the
 *  digit IS the slot number, so rebinding them would cost more clarity
 *  than it gains. */
export type HotkeyAction = "pause" | "turbo" | "rewind" | "screenshot" | "record" | "reset" | "translate" | "assist";
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  "pause",
  "turbo",
  "rewind",
  "screenshot",
  "record",
  "reset",
  "translate",
  "assist"
];
export type HotkeyBindings = Record<HotkeyAction, string>;

export type KeyBindings = Record<Button, string>;

/**
 * Axis bindings come in two flavours:
 *  - **sign-only**: an analog stick (rest near 0) — the binding fires whenever
 *    the axis crosses a deadzone in the chosen direction.
 *  - **POV-hat**: a single axis encodes 8 sectors with discrete values
 *    (rest typically 1.28, sectors at -1, -0.714, … +1). For these we also
 *    store the captured `value` so different directions on the same axis
 *    don't collapse to the same binding.
 */
export type GamepadBinding =
  { type: "button"; index: number } | { type: "axis"; index: number; sign: -1 | 1; value?: number };

/** `null` means the slot has been explicitly cleared — the button is
 *  unmapped until the user re-captures or Reset-gamepad restores the
 *  defaults. Distinct from "missing key" (which would just pick up the
 *  default). */
export type GamepadBindings = Record<Button, GamepadBinding | null>;

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  right: "ArrowRight",
  left: "ArrowLeft",
  up: "ArrowUp",
  down: "ArrowDown",
  a: "KeyZ",
  b: "KeyX",
  start: "Enter",
  select: "ShiftRight"
};

export const DEFAULT_GAMEPAD_BINDINGS: GamepadBindings = {
  a: { type: "button", index: 0 },
  b: { type: "button", index: 1 },
  select: { type: "button", index: 8 },
  start: { type: "button", index: 9 },
  up: { type: "button", index: 12 },
  down: { type: "button", index: 13 },
  left: { type: "button", index: 14 },
  right: { type: "button", index: 15 }
};

export const DEFAULT_HOTKEY_BINDINGS: HotkeyBindings = {
  pause: "Space",
  turbo: "KeyM",
  rewind: "Backspace",
  screenshot: "KeyP",
  record: "KeyV",
  reset: "KeyR",
  translate: "KeyT",
  assist: "KeyG"
};

/** Tilt-input keys for MBC7 carts (Kirby Tilt 'n' Tumble, Command
 *  Master). Keyboard-only — the gamepad equivalent uses the analog
 *  stick / motion sensor handled inside `tilt.ts`, not a discrete
 *  binding. Lives alongside the Game Boy buttons in the Keyboard
 *  section of the Controls editor since the user binds them just like
 *  any other key. */
export type TiltDirection = "tiltForward" | "tiltBack" | "tiltLeft" | "tiltRight";
export const TILT_DIRECTIONS: readonly TiltDirection[] = ["tiltForward", "tiltBack", "tiltLeft", "tiltRight"];
export type TiltBindings = Record<TiltDirection, string>;
export const DEFAULT_TILT_BINDINGS: TiltBindings = {
  tiltForward: "KeyI",
  tiltBack: "KeyK",
  tiltLeft: "KeyJ",
  tiltRight: "KeyL"
};

/** GBA shoulder buttons. The GB hardware has no L/R, so these only
 *  fire on the GBA engine — the keyboard / gamepad routers gate
 *  shoulder dispatch on `state.gba`. Kept in their own bindings record
 *  rather than widening the Game Boy `KeyBindings` so introducing
 *  shoulder support doesn't perturb existing GB users' saved bindings
 *  (the localStorage payload stays the same shape). */
export type ShoulderButton = "l" | "r";
export const SHOULDER_BUTTONS: readonly ShoulderButton[] = ["l", "r"];
export type ShoulderKeyBindings = Record<ShoulderButton, string>;
export type ShoulderGamepadBindings = Record<ShoulderButton, GamepadBinding | null>;

/** Defaults sit one row above the A/B cluster on QWERTY so the four
 *  primary buttons (A/B/L/R) form a small block under the right hand. */
export const DEFAULT_SHOULDER_KEY_BINDINGS: ShoulderKeyBindings = {
  l: "KeyQ",
  r: "KeyE"
};

/** W3C "standard" mapping reserves buttons 4 / 5 for L1 / R1; modern
 *  Xbox / DualShock / Switch Pro all expose shoulders there when the
 *  browser applies the standard mapping. */
export const DEFAULT_SHOULDER_GAMEPAD_BINDINGS: ShoulderGamepadBindings = {
  l: { type: "button", index: 4 },
  r: { type: "button", index: 5 }
};

export function loadKeyBindings(): KeyBindings {
  const raw = lsGet(KEYS.KEY_BINDINGS);
  if (!raw) return { ...DEFAULT_KEY_BINDINGS };
  try {
    return { ...DEFAULT_KEY_BINDINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_KEY_BINDINGS };
  }
}

export function saveKeyBindings(b: KeyBindings): void {
  lsSet(KEYS.KEY_BINDINGS, JSON.stringify(b));
}

export function loadGamepadBindings(): GamepadBindings {
  const raw = lsGet(KEYS.GAMEPAD_BINDINGS);
  if (!raw) return { ...DEFAULT_GAMEPAD_BINDINGS };
  try {
    return { ...DEFAULT_GAMEPAD_BINDINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_GAMEPAD_BINDINGS };
  }
}

export function saveGamepadBindings(b: GamepadBindings): void {
  lsSet(KEYS.GAMEPAD_BINDINGS, JSON.stringify(b));
}

export function loadHotkeyBindings(): HotkeyBindings {
  const raw = lsGet(KEYS.HOTKEY_BINDINGS);
  if (!raw) return { ...DEFAULT_HOTKEY_BINDINGS };
  try {
    return { ...DEFAULT_HOTKEY_BINDINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_HOTKEY_BINDINGS };
  }
}

export function saveHotkeyBindings(b: HotkeyBindings): void {
  lsSet(KEYS.HOTKEY_BINDINGS, JSON.stringify(b));
}

export function loadTiltBindings(): TiltBindings {
  const raw = lsGet(KEYS.TILT_BINDINGS);
  if (!raw) return { ...DEFAULT_TILT_BINDINGS };
  try {
    return { ...DEFAULT_TILT_BINDINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_TILT_BINDINGS };
  }
}

export function saveTiltBindings(b: TiltBindings): void {
  lsSet(KEYS.TILT_BINDINGS, JSON.stringify(b));
}

export function loadShoulderKeyBindings(): ShoulderKeyBindings {
  const raw = lsGet(KEYS.SHOULDER_KEY_BINDINGS);
  if (!raw) return { ...DEFAULT_SHOULDER_KEY_BINDINGS };
  try {
    return { ...DEFAULT_SHOULDER_KEY_BINDINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SHOULDER_KEY_BINDINGS };
  }
}

export function saveShoulderKeyBindings(b: ShoulderKeyBindings): void {
  lsSet(KEYS.SHOULDER_KEY_BINDINGS, JSON.stringify(b));
}

export function loadShoulderGamepadBindings(): ShoulderGamepadBindings {
  const raw = lsGet(KEYS.SHOULDER_GAMEPAD_BINDINGS);
  if (!raw) return { ...DEFAULT_SHOULDER_GAMEPAD_BINDINGS };
  try {
    return { ...DEFAULT_SHOULDER_GAMEPAD_BINDINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SHOULDER_GAMEPAD_BINDINGS };
  }
}

export function saveShoulderGamepadBindings(b: ShoulderGamepadBindings): void {
  lsSet(KEYS.SHOULDER_GAMEPAD_BINDINGS, JSON.stringify(b));
}

/** Friendly label for a tilt direction, shown in the Controls editor
 *  and the cheat-sheet overlay. */
export function describeTilt(d: TiltDirection): string {
  switch (d) {
    case "tiltForward":
      return "Tilt forward";
    case "tiltBack":
      return "Tilt back";
    case "tiltLeft":
      return "Tilt left";
    case "tiltRight":
      return "Tilt right";
  }
}

/** Friendly label for a hotkey action (shown in the Controls editor and
 *  available as a tooltip). */
export function describeHotkey(a: HotkeyAction): string {
  switch (a) {
    case "pause":
      return "Pause";
    case "turbo":
      return "Speed";
    case "rewind":
      return "Rewind";
    case "screenshot":
      return "Screenshot";
    case "record":
      return "Record";
    case "reset":
      return "Reset";
    case "translate":
      return "Translate screen";
    case "assist":
      return "Ask AI about screen";
  }
}

/** Left/right siblings of the four standard modifier keys. The keyboard
 *  router treats each pair as equivalent — binding one half also fires
 *  from the other — so the user doesn't have to remember which Shift
 *  they bound. Apply via {@link mirrorModifierPairs} after building any
 *  `code → action` lookup. */
const MODIFIER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["ShiftLeft", "ShiftRight"],
  ["ControlLeft", "ControlRight"],
  ["AltLeft", "AltRight"],
  ["MetaLeft", "MetaRight"]
];

/** Fill in the sibling of any modifier key that has a binding so either
 *  half fires it. A binding on both halves (e.g. user explicitly bound
 *  A to ShiftLeft and B to ShiftRight) is left alone. */
export function mirrorModifierPairs<T>(map: Record<string, T>): void {
  for (const [a, b] of MODIFIER_PAIRS) {
    if (map[a] !== undefined && map[b] === undefined) map[b] = map[a];
    else if (map[b] !== undefined && map[a] === undefined) map[a] = map[b];
  }
}

/** Pretty label for a `KeyboardEvent.code` value. An empty string
 *  represents a cleared binding — the settings editor lets the user
 *  right-click a chip to unbind — so we show an em-dash rather than
 *  leaving the chip visually empty. Modifier-key labels intentionally
 *  drop the L/R distinction because the keyboard router treats the
 *  two siblings as equivalent (binding either side fires both). */
export function describeKey(code: string): string {
  if (!code) return "—";
  const named: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "Enter",
    Space: "Space",
    ShiftLeft: "Shift",
    ShiftRight: "Shift",
    ControlLeft: "Ctrl",
    ControlRight: "Ctrl",
    AltLeft: "Alt",
    AltRight: "Alt",
    MetaLeft: "Meta",
    MetaRight: "Meta",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/"
  };
  if (named[code]) return named[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export function describeGamepad(b: GamepadBinding | null): string {
  if (!b) return "—";
  if (b.type === "button") return `Btn ${b.index}`;
  if (b.value !== undefined) return `Hat ${b.index}`;
  return `Axis ${b.index}${b.sign > 0 ? "+" : "−"}`;
}

/** Friendly GBA shoulder-button label. */
export function describeShoulder(s: ShoulderButton): string {
  return s === "l" ? "L" : "R";
}

/** Friendly Game Boy button label for the bindings UI. */
export function describeButton(b: Button): string {
  switch (b) {
    case "up":
      return "↑";
    case "down":
      return "↓";
    case "left":
      return "←";
    case "right":
      return "→";
    case "a":
      return "A";
    case "b":
      return "B";
    case "start":
      return "Start";
    case "select":
      return "Select";
  }
}
