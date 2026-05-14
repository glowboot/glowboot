import { saveBlobNative } from "../../save-blob.js";
import { KEYS, lsGet, lsSet } from "../local-storage.js";

/**
 * Settings export / import — user preferences only.
 *
 * Dumps the 13 `gb-*` preference keys from `localStorage` into a single
 * JSON document the user can download, carry to another machine, and
 * import back. Deliberately does **not** touch game progress (save RAM,
 * save states, cheats, library ROM bytes + thumbnails) which lives in
 * IndexedDB and needs its own larger backup tool.
 *
 * Export format:
 *   {
 *     "$": "gameboy-emulator-settings",   // tag for sanity-checking uploads
 *     "version": 1,
 *     "prefs": { "<key>": "<value>", ... } // raw localStorage strings
 *   }
 *
 * Keeping the values as raw strings (same shape `localStorage.getItem`
 * returns) means the import path can just re-write each key without
 * re-running the per-setting parse / validation logic — the consumer
 * modules already handle malformed values at startup.
 */

/** The set of localStorage keys we consider "user preferences". Must
 *  match what the various settings modules read. Cache-only keys
 *  (e.g. `KEYS.CHEAT_INDEX_CACHE`) and per-cart keys (symbols prefix)
 *  are intentionally excluded. */
export const PREF_KEYS = [
  KEYS.THEME,
  KEYS.COLOR_CORRECTION,
  KEYS.INTEGER_SCALE,
  KEYS.PIXEL_RESPONSE,
  KEYS.RENDER_MODE,
  KEYS.COLOR_GRADE,
  KEYS.AUTO_PAUSE,
  KEYS.AUDIO_RUMBLE,
  KEYS.RUMBLE_PRESET,
  KEYS.RUMBLE_STRENGTH,
  KEYS.REWIND_CAPACITY,
  KEYS.LINK_CABLE_MODE,
  KEYS.LINK_ROOM_CODE,
  KEYS.VOLUME,
  KEYS.CHANNEL_MUTES,
  KEYS.AUDIO_MODE,
  KEYS.PALETTE,
  KEYS.TOUCH_MODE,
  KEYS.TOUCH_LAYOUT,
  KEYS.TOUCH_PRESS_HAPTIC,
  KEYS.KEY_BINDINGS,
  KEYS.HOTKEY_BINDINGS,
  KEYS.TILT_BINDINGS,
  KEYS.SETTINGS_COLLAPSED,
  KEYS.LIBRARY_SORT,
  KEYS.GAMEPAD_BINDINGS
] as const;

const TAG = "gameboy-emulator-settings";
const VERSION = 1;

interface SettingsBundle {
  $: string;
  version: number;
  prefs: Record<string, string>;
}

/** Serialise the current preferences into a JSON string. Missing keys are
 *  simply absent from the output — there's no attempt to fill defaults. */
export function exportSettings(): string {
  const prefs: Record<string, string> = {};
  for (const key of PREF_KEYS) {
    const v = lsGet(key);
    if (v !== null) prefs[key] = v;
  }
  const bundle: SettingsBundle = { $: TAG, version: VERSION, prefs };
  return JSON.stringify(bundle, null, 2);
}

/** Parse + validate a previously-exported JSON and write the settings back
 *  to localStorage. Returns true on success, false if the input looks
 *  malformed. Keys not in {@link PREF_KEYS} are ignored so a hostile or
 *  future-version file can't inject arbitrary keys. */
export function importSettings(json: string): boolean {
  let bundle: unknown;
  try {
    bundle = JSON.parse(json);
  } catch {
    return false;
  }
  if (!isBundle(bundle)) return false;
  const allowed = new Set<string>(PREF_KEYS);
  for (const [k, v] of Object.entries(bundle.prefs)) {
    if (!allowed.has(k)) continue;
    if (typeof v !== "string") continue;
    lsSet(k, v);
  }
  return true;
}

function isBundle(x: unknown): x is SettingsBundle {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.$ === TAG && typeof o.version === "number" && !!o.prefs && typeof o.prefs === "object";
}

/** Save the current settings as a pretty-printed JSON file. Filename
 *  includes the date so users can keep multiple snapshots around.
 *  On phones the blob routes through the Web Share API so the OS
 *  share sheet appears; on desktop a `<a download>` fires. */
export async function downloadSettings(): Promise<void> {
  const blob = new Blob([exportSettings()], { type: "application/json" });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `gameboy-settings-${stamp}.json`;
  if (await saveBlobNative(blob, filename)) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — synchronous revoke before the browser's
  // download worker has latched the URL occasionally drops the download
  // in older Safari builds.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
