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
  SCREEN_SIZE: "gb-screen-size",
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
  /** Solar brightness, 0..1 float string. Only meaningful when a Boktai
   *  cart is loaded; persists so the player's preferred "ambient light"
   *  level carries between sessions. */
  SOLAR_BRIGHTNESS: "gb-solar-brightness",

  // ─── Input ─────────────────────────────────────────────────────────
  KEY_BINDINGS: "gb-keys",
  GAMEPAD_BINDINGS: "gb-gamepad",
  HOTKEY_BINDINGS: "gb-hotkeys",
  TILT_BINDINGS: "gb-tilt",
  SHOULDER_KEY_BINDINGS: "gb-shoulder-keys",
  SHOULDER_GAMEPAD_BINDINGS: "gb-shoulder-gamepad",
  TOUCH_MODE: "gb-touch-mode",
  TOUCH_LAYOUT: "gb-touch-layout",
  TOUCH_PRESS_HAPTIC: "gb-touch-press-haptic",
  /** How the on-screen controls behave when the device is held in
   *  landscape. `flank` (default) splits controls into side gutters
   *  with the canvas centred at native aspect; `overlay` floats them
   *  dimmed over a viewport-filling canvas; `reveal` keeps them hidden
   *  until the canvas is tapped; `portrait` keeps the historical
   *  rotate-prompt overlay (opt-in only). */
  TOUCH_LANDSCAPE_LAYOUT: "gb-touch-landscape",

  // ─── Link cable ────────────────────────────────────────────────────
  LINK_CABLE_MODE: "gb-link-cable",
  LINK_ROOM_CODE: "gb-link-room-code",
  /** Experimental opt-in for cross-device GBA Multi-Pak via WebRTC.
   *  Cable-detect protocols (Mario Kart, Tetris VS, Bomberman) are
   *  latency-sensitive — typical internet RTT exceeds what carts
   *  tolerate during the handshake, so this is off by default and
   *  only intended for protocol-tolerant uses (Pokémon-style trade
   *  over Normal-32 mode, slow-paced menu chat). Set to `"1"` in
   *  dev tools to enable. Same-machine BroadcastChannel pairing
   *  is unaffected (always supported). */
  GBA_LINK_CROSS_DEVICE_EXPERIMENTAL: "gb-gba-link-cross-device-experimental",

  // ─── Library / popovers ────────────────────────────────────────────
  LIBRARY_SORT: "gb-library-sort",
  SETTINGS_COLLAPSED: "gb-settings-collapsed",

  // ─── Cheats ────────────────────────────────────────────────────────
  CHEAT_INDEX_CACHE: "gb-cht-index",

  // ─── AI ────────────────────────────────────────────────────────────
  /** Target language (BCP-47) for the on-screen translate overlay.
   *  Browser-language default when unset. */
  TRANSLATE_TARGET: "gb-translate-target",
  /** JSON array of target-language codes whose offline Opus-MT model the
   *  user has downloaded (~100 MB each) — enables translation in browsers
   *  without the Chromium Translator API. */
  MT_DOWNLOADED: "gb-mt-downloaded",

  // ─── AI assist (bring-your-own endpoint) ───────────────────────────
  /** OpenAI-compatible API base URL for the "Ask AI about this screen"
   *  feature (e.g. https://openrouter.ai/api/v1, or a local server). */
  ASSIST_ENDPOINT: "gb-assist-endpoint",
  /** API key for the assist endpoint (sent as a Bearer token). */
  ASSIST_KEY: "gb-assist-key",
  /** Model id for the assist endpoint (e.g. "gpt-4o-mini"). */
  ASSIST_MODEL: "gb-assist-model",
  /** Last dragged position of the assist panel, JSON {x,y}. */
  ASSIST_PANEL_POS: "gb-assist-panel-pos",
  /** "1" once the user has acknowledged the AI-play API-cost confirm
   *  (an agentic session can fire hundreds of requests on their key). */
  AI_PLAY_COST_ACK: "gb-ai-play-cost-ack",
  /** Last dragged position of the translation panel, JSON {x,y}. */
  TRANSLATE_PANEL_POS: "gb-translate-panel-pos"
} as const;

/** Symbols-pane keys are per-cart and use a shared prefix; the cart
 *  module appends its CRC-derived id, then `":meta"` for the metadata
 *  half. Exposed so the symbols pane and any future maintenance tool
 *  share the same scheme. */
export const SYMBOLS_KEY_PREFIX = "gb-symbols-";
export const SYMBOLS_META_SUFFIX = "gb-symbols-meta";
/** Parallel symbol-storage keyspace for GBA carts. The GB and GBA
 *  symbol tables live independently so a cart titled the same on
 *  both consoles (extremely rare but possible) doesn't cross-pollute. */
export const SYMBOLS_KEY_PREFIX_GBA = "gba-symbols-";
export const SYMBOLS_META_SUFFIX_GBA = "gba-symbols-meta";
