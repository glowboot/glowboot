/**
 * Wrapper around `navigator.vibrate` that silently no-ops before any
 * user activation. Chrome blocks pre-activation vibrate calls and
 * logs a "Blocked call to navigator.vibrate" console warning — the
 * skipped call would have been a no-op anyway, so swallowing it just
 * tidies the console (and keeps Lighthouse / DevTools happy).
 *
 * Used by both the on-screen button handlers (`touch.ts`) for tap
 * haptics and the gamepad rumble path (`gamepad.ts`) for cart /
 * audio-driven motor pulses.
 */
export function safeVibrate(ms: number): void {
  if (typeof navigator.vibrate !== "function") return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  navigator.vibrate(ms);
}
