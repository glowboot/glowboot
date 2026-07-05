import type { Button } from "../../gb";
import {
  bindingsGamepadEl,
  bindingsHintEl,
  bindingsHotkeysEl,
  bindingsKeyboardEl,
  bindingsResetHotkeys,
  bindingsResetKey,
  bindingsResetPad
} from "../dom.js";
import * as Bindings from "../input/bindings.js";
import { gamepad } from "../state.js";

/**
 * Settings → Controls editor. Two grids (Keyboard / Gamepad), one chip
 * per joypad button: the eight shared D-pad + A/B/Start/Select that
 * both engines use, plus the Game Boy Advance L / R shoulders
 * (always editable — separate `codeToShoulder` dispatch wires them
 * only when a GBA cart is loaded so the keys stay free under GB).
 * Click a chip to enter capture mode — the next keypress or gamepad
 * input (button / axis / POV-hat sector) is recorded as the new
 * binding. Capture cancels on Escape or by clicking a different chip.
 *
 * Collisions swap rather than overwrite: if the captured input was
 * already assigned to a different button, that button inherits the
 * old binding so no button ends up orphaned.
 *
 * Keyboard bindings are published through the `codeToButton` (eight
 * shared) and `codeToShoulder` (GBA L / R) live-binding exports so
 * `keyboard.ts` picks up re-bindings immediately.
 */

let keyBindings = Bindings.loadKeyBindings();
let gamepadBindings = Bindings.loadGamepadBindings();
let hotkeyBindings = Bindings.loadHotkeyBindings();
let tiltBindings = Bindings.loadTiltBindings();
let shoulderKeyBindings = Bindings.loadShoulderKeyBindings();
let shoulderGamepadBindings = Bindings.loadShoulderGamepadBindings();
let xyKeyBindings = Bindings.loadXyKeyBindings();
let xyGamepadBindings = Bindings.loadXyGamepadBindings();

/** Inverse of `keyBindings` used by the keyboard hot path. Exported as
 *  a mutable binding — `keyboard.ts` reads it on every keydown so
 *  re-bindings are picked up without any signalling. */
export let codeToButton: Record<string, Button> = invertKeyBindings(keyBindings);

/** `KeyboardEvent.code` → hotkey action. Mirror of the `codeToButton`
 *  pattern: live binding, read on every keydown, refreshed on rebind. */
export let codeToHotkey: Record<string, Bindings.HotkeyAction> = invertHotkeys(hotkeyBindings);

/** `KeyboardEvent.code` → GBA shoulder. Dispatched only when a GBA
 *  engine is active; the GB engine has no shoulders to receive the
 *  press, so silently dropping the event there is the correct
 *  behaviour. */
export let codeToShoulder: Record<string, Bindings.ShoulderButton> = invertShoulderKeyBindings(shoulderKeyBindings);

/** `KeyboardEvent.code` → SNES X/Y. Dispatched only when a SNES cart
 *  is active. */
export let codeToXy: Record<string, Bindings.XyButton> = invertXyKeyBindings(xyKeyBindings);

/** Snapshot of gamepad bindings for the shoulder dispatcher in
 *  `gamepad.ts`. Read by `GamepadInput.refreshBindings` whenever the
 *  user changes a binding here. */
export function currentShoulderGamepadBindings(): Bindings.ShoulderGamepadBindings {
  return shoulderGamepadBindings;
}

function invertHotkeys(b: Bindings.HotkeyBindings): Record<string, Bindings.HotkeyAction> {
  const out: Record<string, Bindings.HotkeyAction> = {};
  for (const action of Bindings.HOTKEY_ACTIONS) out[b[action]] = action;
  Bindings.mirrorModifierPairs(out);
  return out;
}

function invertKeyBindings(b: Bindings.KeyBindings): Record<string, Button> {
  const out: Record<string, Button> = {};
  for (const gb of Bindings.GB_BUTTONS) out[b[gb]] = gb;
  Bindings.mirrorModifierPairs(out);
  return out;
}

function invertXyKeyBindings(b: Bindings.XyKeyBindings): Record<string, Bindings.XyButton> {
  const out: Record<string, Bindings.XyButton> = {};
  for (const x of Bindings.XY_BUTTONS) out[b[x]] = x;
  Bindings.mirrorModifierPairs(out);
  return out;
}

function invertShoulderKeyBindings(b: Bindings.ShoulderKeyBindings): Record<string, Bindings.ShoulderButton> {
  const out: Record<string, Bindings.ShoulderButton> = {};
  for (const s of Bindings.SHOULDER_BUTTONS) out[b[s]] = s;
  Bindings.mirrorModifierPairs(out);
  return out;
}

let captureCancel: (() => void) | null = null;

type CaptureSection = "keyboard" | "hotkeys" | "gamepad";

/** The capture-mode hint is a single shared element re-parented to the
 *  active section's `<h4>` whenever capture starts, so the "Press a key…"
 *  prompt always sits next to the section the user is editing. */
function setHint(on: boolean, section?: CaptureSection): void {
  if (!bindingsHintEl) return;
  if (on && section) {
    const h4 = document.querySelector<HTMLElement>(`.settings-section[data-section="${section}"] > h4`);
    const reset = h4?.querySelector(".section-reset");
    if (h4 && reset) h4.insertBefore(bindingsHintEl, reset);
  }
  bindingsHintEl.hidden = !on;
}

/** Reflect the current key bindings in the footer "Controls" legend so
 *  rebinding a button (e.g. A → KeyQ) updates the footer's `Z` label
 *  immediately. D-Pad is displayed as the four directional keys joined
 *  in up/down/left/right order — matches the default "↑↓←→" rendering
 *  and degrades to e.g. "WSAD" for WASD-style remaps.
 *
 *  The target elements live in the static footer markup — cache them
 *  at module init so each rebind is a plain textContent write instead
 *  of three querySelectorAll sweeps. */
interface StripBtnCache {
  btn: Button;
  key: HTMLElement;
}
interface StripShoulderCache {
  btn: Bindings.ShoulderButton;
  key: HTMLElement;
}
interface StripHkCache {
  action: Bindings.HotkeyAction;
  key: HTMLElement;
}
const stripBtnCells: StripBtnCache[] = Array.from(document.querySelectorAll<HTMLElement>("[data-gb-btn]"))
  .map((el) => {
    const btn = el.dataset.gbBtn as Button | undefined;
    const key = el.querySelector<HTMLElement>(".key");
    if (!btn || !key) return null;
    return { btn, key };
  })
  .filter((x): x is StripBtnCache => x !== null);
const stripDpadCell: HTMLElement | null = document.querySelector<HTMLElement>('[data-gb-group="dpad"] .key');
const stripShoulderCells: StripShoulderCache[] = Array.from(document.querySelectorAll<HTMLElement>("[data-gba-btn]"))
  .map((el) => {
    const btn = el.dataset.gbaBtn as Bindings.ShoulderButton | undefined;
    const key = el.querySelector<HTMLElement>(".key");
    if (!btn || !key) return null;
    return { btn, key };
  })
  .filter((x): x is StripShoulderCache => x !== null);
const stripHkCells: StripHkCache[] = Array.from(document.querySelectorAll<HTMLElement>("[data-hk-action]"))
  .map((el) => {
    const action = el.dataset.hkAction as Bindings.HotkeyAction | undefined;
    const key = el.querySelector<HTMLElement>(".key");
    if (!action || !key) return null;
    return { action, key };
  })
  .filter((x): x is StripHkCache => x !== null);

function syncControlsStrip(): void {
  for (const { btn, key } of stripBtnCells) {
    key.textContent = Bindings.describeKey(keyBindings[btn]);
  }
  if (stripDpadCell) {
    stripDpadCell.textContent =
      Bindings.describeKey(keyBindings.up) +
      Bindings.describeKey(keyBindings.down) +
      Bindings.describeKey(keyBindings.left) +
      Bindings.describeKey(keyBindings.right);
  }
  for (const { btn, key } of stripShoulderCells) {
    key.textContent = Bindings.describeKey(shoulderKeyBindings[btn]);
  }
  for (const { action, key } of stripHkCells) {
    key.textContent = Bindings.describeKey(hotkeyBindings[action]);
  }
}

function renderBindingsKeyboard(): void {
  if (!bindingsKeyboardEl) return;
  const kbEl = bindingsKeyboardEl;
  kbEl.innerHTML = "";
  // Row order mirrors the keyboard cheat sheet: D-Pad, A, B, X, Y, L, R,
  // Start, Select — one controller surface, not per-console groups.
  const addButtonRow = (gb: Button): void => {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeButton(gb);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeKey(keyBindings[gb]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startKeyCapture(gb, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
      keyBindings = { ...keyBindings, [gb]: "" } as Bindings.KeyBindings;
      Bindings.saveKeyBindings(keyBindings);
      codeToButton = invertKeyBindings(keyBindings);
      renderBindingsKeyboard();
      syncControlsStrip();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    kbEl.appendChild(row);
  };
  for (const gb of ["up", "down", "left", "right", "a", "b"] as const) addButtonRow(gb);
  // SNES X / Y chips — inert on other consoles, dispatched by the
  // keyboard router only when `state.snes` is non-null.
  for (const x of Bindings.XY_BUTTONS) {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeXy(x);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeKey(xyKeyBindings[x]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startXyKeyCapture(x, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
      xyKeyBindings = { ...xyKeyBindings, [x]: "" } as Bindings.XyKeyBindings;
      Bindings.saveXyKeyBindings(xyKeyBindings);
      codeToXy = invertXyKeyBindings(xyKeyBindings);
      renderBindingsKeyboard();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    bindingsKeyboardEl.appendChild(row);
  }
  // GBA + SNES shoulder chips (L/R serve both consoles).
  for (const s of Bindings.SHOULDER_BUTTONS) {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeShoulder(s);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeKey(shoulderKeyBindings[s]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startShoulderKeyCapture(s, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
      shoulderKeyBindings = { ...shoulderKeyBindings, [s]: "" } as Bindings.ShoulderKeyBindings;
      Bindings.saveShoulderKeyBindings(shoulderKeyBindings);
      codeToShoulder = invertShoulderKeyBindings(shoulderKeyBindings);
      renderBindingsKeyboard();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    bindingsKeyboardEl.appendChild(row);
  }
  for (const gb of ["start", "select"] as const) addButtonRow(gb);

  // Tilt direction chips share the Keyboard section because they're
  // keyboard-only inputs; only a handful of carts (MBC7 GB titles like
  // Kirby Tilt 'n' Tumble, plus GBA tilt titles like Yoshi Topsy-Turvy
  // and WarioWare Twisted) actually consume them, otherwise the keys
  // are inert. Listed last in the section so the universally-applicable
  // bindings come first; the niche tilt rebinder stays accessible but
  // doesn't push L/R down for the average user.
  for (const dir of Bindings.TILT_DIRECTIONS) {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeTilt(dir);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeKey(tiltBindings[dir]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startTiltCapture(dir, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
      tiltBindings = { ...tiltBindings, [dir]: "" } as Bindings.TiltBindings;
      Bindings.saveTiltBindings(tiltBindings);
      renderBindingsKeyboard();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    bindingsKeyboardEl.appendChild(row);
  }
}

function renderHotkeys(): void {
  if (!bindingsHotkeysEl) return;
  bindingsHotkeysEl.innerHTML = "";
  for (const action of Bindings.HOTKEY_ACTIONS) {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeHotkey(action);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeKey(hotkeyBindings[action]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startHotkeyCapture(action, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
      hotkeyBindings = { ...hotkeyBindings, [action]: "" } as Bindings.HotkeyBindings;
      Bindings.saveHotkeyBindings(hotkeyBindings);
      codeToHotkey = invertHotkeys(hotkeyBindings);
      renderHotkeys();
      syncControlsStrip();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    bindingsHotkeysEl.appendChild(row);
  }
}

function startHotkeyCapture(action: Bindings.HotkeyAction, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "hotkeys");
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") {
      endCapture();
      renderHotkeys();
      return;
    }
    // Collision with another hotkey: swap so no action ends up orphaned.
    // Collision with a GB button is not auto-resolved — the keyboard
    // handler runs hotkeys before joypad so the GB button is effectively
    // shadowed, and the Controls editor shows the clash for the user to
    // untangle if they notice.
    const prevOwner = Bindings.HOTKEY_ACTIONS.find((a) => a !== action && hotkeyBindings[a] === e.code);
    const next = { ...hotkeyBindings, [action]: e.code } as Bindings.HotkeyBindings;
    if (prevOwner) next[prevOwner] = hotkeyBindings[action];
    hotkeyBindings = next;
    Bindings.saveHotkeyBindings(hotkeyBindings);
    codeToHotkey = invertHotkeys(hotkeyBindings);
    endCapture();
    renderHotkeys();
    syncControlsStrip();
  };
  window.addEventListener("keydown", onKey, { capture: true, once: true });
  captureCancel = () => window.removeEventListener("keydown", onKey, { capture: true });
}

function renderBindingsGamepad(): void {
  if (!bindingsGamepadEl) return;
  const gpEl = bindingsGamepadEl;
  gpEl.innerHTML = "";
  // Same row order as the keyboard section and the cheat sheet.
  const addButtonRow = (gb: Button): void => {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeButton(gb);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeGamepad(gamepadBindings[gb]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startGamepadCapture(gb, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
      gamepadBindings = { ...gamepadBindings, [gb]: null } as Bindings.GamepadBindings;
      Bindings.saveGamepadBindings(gamepadBindings);
      gamepad.refreshBindings();
      renderBindingsGamepad();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    gpEl.appendChild(row);
  };
  for (const gb of ["up", "down", "left", "right", "a", "b"] as const) addButtonRow(gb);

  // SNES X / Y gamepad chips — same gating as the keyboard side.
  for (const x of Bindings.XY_BUTTONS) {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeXy(x);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeGamepad(xyGamepadBindings[x]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startXyGamepadCapture(x, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      xyGamepadBindings = { ...xyGamepadBindings, [x]: null };
      Bindings.saveXyGamepadBindings(xyGamepadBindings);
      gamepad.refreshBindings();
      renderBindingsGamepad();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    bindingsGamepadEl.appendChild(row);
  }
  // GBA shoulder gamepad chips — same gating as the keyboard side.
  for (const s of Bindings.SHOULDER_BUTTONS) {
    const row = document.createElement("div");
    row.className = "binding-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = Bindings.describeShoulder(s);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "binding-chip";
    chip.title = "Click to rebind • Right-click to clear";
    chip.textContent = Bindings.describeGamepad(shoulderGamepadBindings[s]);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      startShoulderGamepadCapture(s, chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      endCapture();
      shoulderGamepadBindings = { ...shoulderGamepadBindings, [s]: null } as Bindings.ShoulderGamepadBindings;
      Bindings.saveShoulderGamepadBindings(shoulderGamepadBindings);
      gamepad.refreshBindings();
      renderBindingsGamepad();
    });
    row.appendChild(lbl);
    row.appendChild(chip);
    bindingsGamepadEl.appendChild(row);
  }

  for (const gb of ["start", "select"] as const) addButtonRow(gb);
}

function endCapture(): void {
  captureCancel?.();
  captureCancel = null;
  setHint(false);
  document.querySelectorAll(".binding-chip.listening").forEach((el) => el.classList.remove("listening"));
}

function startKeyCapture(gb: Button, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "keyboard");
  // Capture-phase listener so the global keydown handler doesn't first
  // process the keystroke as a hotkey or joypad press.
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") {
      endCapture();
      renderBindingsKeyboard();
      return;
    }
    const prevOwner = Bindings.GB_BUTTONS.find((g) => g !== gb && keyBindings[g] === e.code);
    const next = { ...keyBindings, [gb]: e.code } as Bindings.KeyBindings;
    if (prevOwner) next[prevOwner] = keyBindings[gb];
    keyBindings = next;
    Bindings.saveKeyBindings(keyBindings);
    codeToButton = invertKeyBindings(keyBindings);
    endCapture();
    renderBindingsKeyboard();
    syncControlsStrip();
  };
  window.addEventListener("keydown", onKey, { capture: true, once: true });
  captureCancel = () => window.removeEventListener("keydown", onKey, { capture: true });
}

function startTiltCapture(dir: Bindings.TiltDirection, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "keyboard");
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") {
      endCapture();
      renderBindingsKeyboard();
      return;
    }
    // Collisions within tilt swap (so no direction ends up unbound) but
    // we don't try to deconflict against GB buttons or hotkeys — the
    // user can knowingly overload, e.g. binding "Tilt forward" to the
    // same key as "Up" if the cart they're playing doesn't use both.
    const prevOwner = Bindings.TILT_DIRECTIONS.find((d) => d !== dir && tiltBindings[d] === e.code);
    const next = { ...tiltBindings, [dir]: e.code } as Bindings.TiltBindings;
    if (prevOwner) next[prevOwner] = tiltBindings[dir];
    tiltBindings = next;
    Bindings.saveTiltBindings(tiltBindings);
    endCapture();
    renderBindingsKeyboard();
  };
  window.addEventListener("keydown", onKey, { capture: true, once: true });
  captureCancel = () => window.removeEventListener("keydown", onKey, { capture: true });
}

function startShoulderKeyCapture(s: Bindings.ShoulderButton, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "keyboard");
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") {
      endCapture();
      renderBindingsKeyboard();
      return;
    }
    // Swap within shoulders so the other one doesn't end up unbound,
    // but don't deconflict against GB buttons / hotkeys / tilt — the
    // user can knowingly overload since shoulders are GBA-only and
    // the GB engine simply won't receive the dispatched press.
    const prevOwner = Bindings.SHOULDER_BUTTONS.find((o) => o !== s && shoulderKeyBindings[o] === e.code);
    const next = { ...shoulderKeyBindings, [s]: e.code } as Bindings.ShoulderKeyBindings;
    if (prevOwner) next[prevOwner] = shoulderKeyBindings[s];
    shoulderKeyBindings = next;
    Bindings.saveShoulderKeyBindings(shoulderKeyBindings);
    codeToShoulder = invertShoulderKeyBindings(shoulderKeyBindings);
    endCapture();
    renderBindingsKeyboard();
  };
  window.addEventListener("keydown", onKey, { capture: true, once: true });
  captureCancel = () => window.removeEventListener("keydown", onKey, { capture: true });
}

/** Equality for two captured gamepad bindings. Two button bindings
 *  match when their button index is the same; two axis bindings match
 *  when index + sign agree and the value (when both ends supply one)
 *  is within a small float-noise tolerance. Used by the capture flows
 *  to detect when the just-captured binding is already owned by some
 *  other Game Boy / shoulder button, so the previous owner can be
 *  re-assigned the displaced binding rather than left with a stale
 *  duplicate.
 *
 *  Defined at module scope so both `startGamepadCapture` (GB buttons)
 *  and `startShoulderGamepadCapture` (L/R shoulders) share one
 *  implementation. */
function sameGamepadBinding(a: Bindings.GamepadBinding, b: Bindings.GamepadBinding): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "button") return a.index === (b as typeof a).index;
  const bb = b as Extract<Bindings.GamepadBinding, { type: "axis" }>;
  if (a.index !== bb.index || a.sign !== bb.sign) return false;
  if (a.value !== undefined && bb.value !== undefined) return Math.abs(a.value - bb.value) < 0.1;
  return a.value === bb.value;
}

function startShoulderGamepadCapture(s: Bindings.ShoulderButton, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "gamepad");
  const onEsc = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      e.preventDefault();
      endCapture();
      renderBindingsGamepad();
    }
  };
  window.addEventListener("keydown", onEsc, { capture: true });
  const cancelPad = gamepad.captureNext((binding) => {
    const prevOwner = Bindings.SHOULDER_BUTTONS.find((o) => {
      if (o === s) return false;
      const other = shoulderGamepadBindings[o];
      return other !== null && sameGamepadBinding(other, binding);
    });
    const next = { ...shoulderGamepadBindings, [s]: binding } as Bindings.ShoulderGamepadBindings;
    if (prevOwner) next[prevOwner] = shoulderGamepadBindings[s];
    shoulderGamepadBindings = next;
    Bindings.saveShoulderGamepadBindings(shoulderGamepadBindings);
    gamepad.refreshBindings();
    endCapture();
    renderBindingsGamepad();
  });
  captureCancel = () => {
    cancelPad();
    window.removeEventListener("keydown", onEsc, { capture: true });
  };
}

function startXyKeyCapture(x: Bindings.XyButton, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "keyboard");
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") {
      endCapture();
      renderBindingsKeyboard();
      return;
    }
    // Swap within X/Y so the other doesn't end up unbound; like the
    // shoulders, no deconfliction against other groups — X/Y only fire
    // on SNES carts.
    const prevOwner = Bindings.XY_BUTTONS.find((o) => o !== x && xyKeyBindings[o] === e.code);
    const next = { ...xyKeyBindings, [x]: e.code } as Bindings.XyKeyBindings;
    if (prevOwner) next[prevOwner] = xyKeyBindings[x];
    xyKeyBindings = next;
    Bindings.saveXyKeyBindings(xyKeyBindings);
    codeToXy = invertXyKeyBindings(xyKeyBindings);
    endCapture();
    renderBindingsKeyboard();
  };
  window.addEventListener("keydown", onKey, { capture: true, once: true });
  captureCancel = () => window.removeEventListener("keydown", onKey, { capture: true });
}

function startXyGamepadCapture(x: Bindings.XyButton, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "gamepad");
  const onEsc = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      e.preventDefault();
      endCapture();
      renderBindingsGamepad();
    }
  };
  window.addEventListener("keydown", onEsc, { capture: true });
  const cancelPad = gamepad.captureNext((binding) => {
    const prevOwner = Bindings.XY_BUTTONS.find((o) => {
      if (o === x) return false;
      const other = xyGamepadBindings[o];
      return other !== null && sameGamepadBinding(other, binding);
    });
    const next = { ...xyGamepadBindings, [x]: binding } as Bindings.XyGamepadBindings;
    if (prevOwner) next[prevOwner] = xyGamepadBindings[x];
    xyGamepadBindings = next;
    Bindings.saveXyGamepadBindings(xyGamepadBindings);
    gamepad.refreshBindings();
    endCapture();
    renderBindingsGamepad();
  });
  captureCancel = () => {
    cancelPad();
    window.removeEventListener("keydown", onEsc, { capture: true });
  };
}

function startGamepadCapture(gb: Button, chip: HTMLElement): void {
  endCapture();
  chip.classList.add("listening");
  chip.textContent = "…";
  setHint(true, "gamepad");
  const onEsc = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      e.preventDefault();
      endCapture();
      renderBindingsGamepad();
    }
  };
  window.addEventListener("keydown", onEsc, { capture: true });
  const cancelPad = gamepad.captureNext((binding) => {
    // Cleared slots (null) can't collide — skip them in the search.
    const prevOwner = Bindings.GB_BUTTONS.find((g) => {
      if (g === gb) return false;
      const other = gamepadBindings[g];
      return other !== null && sameGamepadBinding(other, binding);
    });
    const next = { ...gamepadBindings, [gb]: binding } as Bindings.GamepadBindings;
    if (prevOwner) next[prevOwner] = gamepadBindings[gb];
    gamepadBindings = next;
    Bindings.saveGamepadBindings(gamepadBindings);
    gamepad.refreshBindings();
    endCapture();
    renderBindingsGamepad();
  });
  captureCancel = () => {
    cancelPad();
    window.removeEventListener("keydown", onEsc, { capture: true });
  };
}

bindingsResetKey?.addEventListener("click", (e) => {
  e.stopPropagation();
  endCapture();
  keyBindings = { ...Bindings.DEFAULT_KEY_BINDINGS };
  tiltBindings = { ...Bindings.DEFAULT_TILT_BINDINGS };
  shoulderKeyBindings = { ...Bindings.DEFAULT_SHOULDER_KEY_BINDINGS };
  Bindings.saveKeyBindings(keyBindings);
  Bindings.saveTiltBindings(tiltBindings);
  Bindings.saveShoulderKeyBindings(shoulderKeyBindings);
  codeToButton = invertKeyBindings(keyBindings);
  codeToShoulder = invertShoulderKeyBindings(shoulderKeyBindings);
  renderBindingsKeyboard();
  syncControlsStrip();
});
bindingsResetPad?.addEventListener("click", (e) => {
  e.stopPropagation();
  endCapture();
  gamepadBindings = { ...Bindings.DEFAULT_GAMEPAD_BINDINGS };
  shoulderGamepadBindings = { ...Bindings.DEFAULT_SHOULDER_GAMEPAD_BINDINGS };
  Bindings.saveGamepadBindings(gamepadBindings);
  Bindings.saveShoulderGamepadBindings(shoulderGamepadBindings);
  gamepad.refreshBindings();
  renderBindingsGamepad();
});
bindingsResetHotkeys?.addEventListener("click", (e) => {
  e.stopPropagation();
  endCapture();
  hotkeyBindings = { ...Bindings.DEFAULT_HOTKEY_BINDINGS };
  Bindings.saveHotkeyBindings(hotkeyBindings);
  codeToHotkey = invertHotkeys(hotkeyBindings);
  renderHotkeys();
  syncControlsStrip();
});

renderBindingsKeyboard();
renderBindingsGamepad();
renderHotkeys();
syncControlsStrip();
