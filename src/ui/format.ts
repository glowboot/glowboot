/** String formatters shared across popovers and the status strip, plus a
 *  couple of tiny DOM-event predicates that also didn't belong anywhere
 *  feature-specific. No external dependencies — pure functions only. */

/** "mm:ss" for under an hour, "h:mm:ss" once the session has passed 1h. */
export function formatTime(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const ssStr = String(ss).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ssStr}` : `${mm}:${ssStr}`;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago". */
export function relativeTime(ms: number): string {
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

/** Cumulative play-time pretty-print: "<1m" / "45m" / "2h 14m" / "1d 5h". */
export function formatPlayTime(ms: number): string {
  if (ms < 60_000) return "<1m";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

/** Map a `KeyboardEvent.code` of the form "Digit0".."Digit9" to the digit
 *  it represents, or null for anything else. */
export function slotFromCode(code: string): number | null {
  if (code.length === 6 && code.startsWith("Digit")) {
    const n = parseInt(code.slice(5), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** True when a text field has focus — hotkeys / joypad bindings must
 *  yield to it so the user can type into forms (cheat codes, etc.). */
export function inTextInput(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
}

/** True when focus is on an interactive UI element (button, link, etc.)
 *  rather than the playing surface (canvas / body). The keyboard router
 *  yields the keystroke when this is true so:
 *   - Space / Enter activate the focused button (instead of pause /
 *     joypad-Start),
 *   - arrow keys move within radio groups / listboxes (instead of D-pad).
 *  When the user clicks the canvas (or focus is implicit on body), the
 *  emulator regains all keys as before. */
const NON_UI_TAGS = new Set(["BODY", "HTML", "CANVAS"]);
export function inUiControl(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return !NON_UI_TAGS.has(t.tagName);
}
