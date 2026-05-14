import { errorToast } from "../hud/toast.js";

/**
 * Safe wrappers around the synchronous `localStorage` API + the
 * canonical key catalogue.
 *
 * Direct `localStorage` access can throw in several setups: private /
 * incognito mode (where `setItem` raises `QuotaExceededError` even on
 * a fresh key), quota exhaustion, "block third-party cookies + site
 * data" settings, and cross-origin iframe contexts. Without these
 * wrappers every call site has to remember its own try/catch — easy
 * to miss, and the codebase already had a dozen copy-pasted boilerplate
 * guards before this module existed.
 *
 * On the first failure of a session we surface a single error toast so
 * the user knows their settings won't persist; subsequent failures log
 * to the console only, to avoid spamming the UI on every keystroke
 * that happens to hit the disabled API.
 *
 * The `KEYS` catalogue and the symbol-prefix exports below live in the
 * same file as the wrappers because no consumer ever uses one without
 * the other — splitting them just doubles the import lines for zero
 * decoupling benefit.
 */

let warnedThisSession = false;

function reportFailure(op: "get" | "set" | "remove", key: string, err: unknown): void {
  console.warn(`[Storage] localStorage.${op}("${key}") failed:`, err);
  if (warnedThisSession) return;
  warnedThisSession = true;
  errorToast("Browser storage is unavailable — changes won't be saved.");
}

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    reportFailure("get", key, err);
    return null;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    reportFailure("set", key, err);
  }
}

export function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    reportFailure("remove", key, err);
  }
}

/**
 * Single source of truth for every key the app reads or writes in
 * `localStorage`. Centralised so a typo in any one call site can't
 * silently desync from the rest of the codebase, renaming a key is
 * one edit, and the export/import allow-list (`PREF_KEYS` in
 * `persistence/io/settings.ts`) can pull from this object instead of
 * duplicating the strings.
 */
export const KEYS = {
  // ─── Display ───────────────────────────────────────────────────────
  RENDER_MODE: "gb-render-mode",
  COLOR_CORRECTION: "gb-color-correction",
  INTEGER_SCALE: "gb-integer-scale",
  PIXEL_RESPONSE: "gb-pixel-response",
  COLOR_GRADE: "gb-grade",
  PALETTE: "gb-palette",
  THEME: "gb-theme",

  // ─── Audio ─────────────────────────────────────────────────────────
  VOLUME: "gb-volume",
  CHANNEL_MUTES: "gb-mutes",
  AUDIO_MODE: "gb-audio-mode",
  AUDIO_RUMBLE: "gb-audio-rumble",
  RUMBLE_PRESET: "gb-rumble-preset",
  RUMBLE_STRENGTH: "gb-rumble-strength",

  // ─── Session / behaviour ───────────────────────────────────────────
  AUTO_PAUSE: "gb-auto-pause",
  REWIND_CAPACITY: "gb-rewind-capacity",

  // ─── Input ─────────────────────────────────────────────────────────
  KEY_BINDINGS: "gb-keys",
  GAMEPAD_BINDINGS: "gb-gamepad",
  HOTKEY_BINDINGS: "gb-hotkeys",
  TILT_BINDINGS: "gb-tilt",
  TOUCH_MODE: "gb-touch-mode",
  TOUCH_LAYOUT: "gb-touch-layout",
  TOUCH_PRESS_HAPTIC: "gb-touch-press-haptic",

  // ─── Link cable ────────────────────────────────────────────────────
  LINK_CABLE_MODE: "gb-link-cable",
  LINK_ROOM_CODE: "gb-link-room-code",

  // ─── Library / popovers ────────────────────────────────────────────
  LIBRARY_SORT: "gb-library-sort",
  SETTINGS_COLLAPSED: "gb-settings-collapsed",

  // ─── Cheats ────────────────────────────────────────────────────────
  CHEAT_INDEX_CACHE: "gb-cht-index"
} as const;

/** Symbols-pane keys are per-cart and use a shared prefix; the cart
 *  module appends its CRC-derived id, then `":meta"` for the metadata
 *  half. Exposed so the symbols pane and any future maintenance tool
 *  share the same scheme. */
export const SYMBOLS_KEY_PREFIX = "gb-symbols-";
export const SYMBOLS_META_SUFFIX = "gb-symbols-meta";
