import { KEYS, lsGet } from "../persistence/local-storage.js";
import { state } from "../state.js";
import { togglePause } from "./actions.js";

/**
 * Auto-pause on focus loss. When the setting is on (default) and a game
 * is running, the emulator pauses when the browser window loses focus
 * (alt-tab, clicking another app, opening devtools in a separate window)
 * and resumes when focus returns.
 *
 * We listen on `window.blur` / `window.focus` rather than
 * `visibilitychange` — the latter only fires on tab-switch / minimise,
 * not on simply moving focus to another window next to the browser.
 * Visibility changes are already handled in autosave.ts for RTC drift
 * and save-RAM flushing; this module is strictly about pause/resume UX.
 *
 * Manual pauses (user pressed Space before losing focus) must not
 * auto-resume — flagging `state.autoPausedOnBlur` distinguishes our own
 * pauses from user-initiated ones so blur→focus cycles leave the latter
 * alone.
 */

function enabled(): boolean {
  return lsGet(KEYS.AUTO_PAUSE) !== "0";
}

window.addEventListener("blur", () => {
  if (!enabled()) return;
  if (!state.gb || state.paused) return;
  state.autoPausedOnBlur = true;
  void togglePause();
});

window.addEventListener("focus", () => {
  if (!state.autoPausedOnBlur) return;
  state.autoPausedOnBlur = false;
  if (!state.gb || !state.paused) return;
  void togglePause();
});
