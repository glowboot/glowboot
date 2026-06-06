import * as SaveRam from "../persistence/save-ram.js";
import * as SaveRamGba from "../persistence/save-ram-gba.js";
import * as SaveState from "../persistence/save-state.js";
import { state } from "../state.js";
import { flushPlayTime, startPlayTimer } from "./play-time.js";

/**
 * Background save hooks. Three triggers:
 *   1. 2 s interval → Save-RAM only (cheap, runs while playing).
 *   2. visibilitychange → hidden: flush save-RAM, auto-snapshot, play time.
 *                         visible: re-arm the play-time counter unless paused.
 *   3. beforeunload → best-effort flush of the three above; the browser
 *      may tear the tab down before the async writes complete, but the
 *      2 s interval has almost certainly persisted anything recent.
 *
 * The full engine snapshot (auto-state) is heavier than Save-RAM, so we
 * only take it on tab-hide / close — not every 2 s — to avoid the I/O
 * cost of constantly re-serialising the CPU / PPU.
 */

setInterval(() => {
  if (state.gb) void SaveRam.save(state.gb.cart);
  if (state.gba) void SaveRamGba.save(state.gba);
}, 2000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (state.gb) {
      void SaveRam.save(state.gb.cart, true);
      void SaveState.saveAutoState(state.gb);
    }
    if (state.gba) {
      void SaveRamGba.save(state.gba, true);
      void SaveState.saveAutoState(state.gba);
    }
    // Play-time tracker is engine-agnostic (it keys off state.playTrackingId
    // which is set by both rom-loader paths). Fire once if anything's running.
    if (state.gb || state.gba) void flushPlayTime();
    // Stamp the RTC pause marker only if nothing else has. Pairs with the
    // resume branch below (and with togglePause) so a multi-hour hide
    // credits the cart clock on whichever path the user resumes through.
    // GB-only — GBA has no MBC3-style RTC.
    if (state.gb && state.rtcWallPauseMs === 0) state.rtcWallPauseMs = Date.now();
  } else if (document.visibilityState === "visible") {
    if (state.gb && !state.paused && state.rtcWallPauseMs > 0) {
      state.gb.cart.advanceRtcByWallMs(Date.now() - state.rtcWallPauseMs);
      state.rtcWallPauseMs = 0;
    }
    if ((state.gb || state.gba) && !state.paused) startPlayTimer();
  }
});

window.addEventListener("beforeunload", () => {
  if (state.gb) {
    void SaveRam.save(state.gb.cart, true);
    void SaveState.saveAutoState(state.gb);
  }
  if (state.gba) {
    void SaveRamGba.save(state.gba, true);
    void SaveState.saveAutoState(state.gba);
  }
  if (state.gb || state.gba) void flushPlayTime();
});
