/**
 * Pure pacing-math helpers for the GBA rAF loop. Lives in its own
 * file (rather than alongside the `startGbaSession` runtime) so the
 * unit tests can import it without dragging the DOM-touching modules
 * (`dom.ts`, `hud/status.ts`, ...) into a Node-only test runner.
 */

import { FRAMES_PER_SEC } from "../../gba";

/** Real GBA frame budget: 16,777,216 / 280,896 ≈ 59.7275 Hz → one
 *  frame every ~16.743 ms. (Spec value from GBATEK; same as the GB
 *  spec rate, which is no coincidence — Nintendo kept the LCD
 *  refresh constant across generations.) */
const FRAME_MS = 1000 / FRAMES_PER_SEC;
/** Cap on how many catch-up frames we'll run in a single rAF if the
 *  page has been throttled (e.g. tab hidden, paused at a breakpoint).
 *  Higher → faster recovery from a stall, but a long pause then
 *  resumes with a visible audio glitch if we try to fast-forward
 *  more than a few frames at once. Same value pacing.ts uses for GB. */
const MAX_CATCHUP_FRAMES = 4;

/** Pure helper that computes how many emulator frames to run on a
 *  given rAF tick, given the wall-clock elapsed since the previous
 *  tick, the carried-over fractional `frameDebt`, the user's speed
 *  multiplier, and the catch-up cap. Returns the integer frame count
 *  and the new fractional carry. */
export function nextFrameBudget(
  elapsedMs: number,
  frameDebt: number,
  speedMultiplier: number,
  maxCatchupFrames: number = MAX_CATCHUP_FRAMES
): { toRun: number; newDebt: number } {
  const accumulated = frameDebt + (elapsedMs / FRAME_MS) * speedMultiplier;
  // At >1× the cap scales so a backgrounded tab's catch-up burst
  // still bounds to ≈ MAX_CATCHUP_FRAMES wall-clock frames of work.
  // At <1× the cap stays at MAX_CATCHUP_FRAMES — we never want
  // slow-mo to silently halve the catch-up budget.
  const cap = maxCatchupFrames * Math.max(1, speedMultiplier);
  let toRun = Math.floor(accumulated);
  let newDebt = accumulated - toRun;
  if (toRun > cap) {
    // Stall recovery (tab backgrounded so rAF paused, breakpoint, a long
    // GC): run the cap and DROP the backlog instead of carrying it as
    // debt. Carrying it replays the entire hidden gap as a sustained
    // multi-second burst at the cap rate after refocus — the game runs
    // ~4× too fast and the heavy per-tick work collapses the render rate.
    // The GB pacer avoids this by clamping its accumulator; mirror that.
    toRun = cap;
    newDebt = 0;
  }
  return { toRun, newDebt };
}
