import * as Recents from "../persistence/recents.js";
import { state } from "../state.js";

/**
 * Per-game play-time tracking. Accumulates wall-clock time while the
 * emulator is ticking and flushes to the library record on pause,
 * tab-hide, ROM switch, and periodically via setInterval (crash guard).
 *
 * The counter is intentionally wall-clock not emulated-cycle time — the
 * library stat answers "how much time did I spend with this game?" not
 * "how many Game Boy seconds did it simulate?", which diverge during
 * turbo or pause.
 */

export function startPlayTimer(): void {
  if (!state.playTrackingId) return;
  state.playSessionStart = performance.now();
}

export async function flushPlayTime(): Promise<void> {
  if (state.playSessionStart === null || !state.playTrackingId) return;
  const now = performance.now();
  const elapsed = now - state.playSessionStart;
  state.playSessionStart = null;
  if (elapsed >= 100) await Recents.addPlayTime(state.playTrackingId, elapsed);
}

// Periodic flush so a browser crash in the middle of a long session only
// loses ~30 s of tracked time instead of hours.
setInterval(() => {
  if (state.playSessionStart !== null) {
    void flushPlayTime().then(() => startPlayTimer());
  }
}, 30_000);
