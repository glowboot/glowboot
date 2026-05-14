import { overlayRewind, statusEl, timeEl } from "../dom.js";
import { formatTime } from "../format.js";
import { announce } from "../hud/announce.js";
import { audio, renderer, state } from "../state.js";
import { startPacing, stopPacing } from "./pacing.js";

/**
 * `Backspace`-held rewind scrubber. Stops normal emulation and walks the
 * rewind ring buffer backwards at a fixed wall-clock cadence (one
 * snapshot per `STEP_MS`), rolling the UI counters (frame number,
 * elapsed clock) back so they stay in sync with the snapshotted engine
 * state. Each snapshot corresponds to ~1 s of gameplay, so a 200 ms step
 * gives roughly 5× rewind speed — fast enough to skip back over ten
 * seconds quickly, slow enough to eyeball the preview and let go at
 * the right moment.
 */

/** Wall-clock milliseconds between snapshot pops while holding rewind.
 *  Independent of display refresh rate so the scrub speed is the same
 *  on 60 Hz and 144 Hz monitors. */
const STEP_MS = 200;

let lastStepAt = 0;

/** Elapsed-ms value of the frame the user pressed Rewind on. Used to
 *  derive the "-Xs" delta shown inside the rewind overlay; subtracted
 *  from each popped snapshot's elapsed value as the user scrubs. */
let rewindStartElapsedMs = 0;

export function startRewind(): void {
  const gb = state.gb;
  const rewinder = state.rewinder;
  if (state.rewinding || !gb || !rewinder) return;
  state.rewinding = true;
  stopPacing();
  void audio.suspend();
  rewinder.stop();
  overlayRewind?.classList.add("active");
  if (overlayRewind) overlayRewind.dataset.delta = "-0.0s";
  if (statusEl) statusEl.textContent = "Rewinding";
  announce("Rewinding");
  rewindStartElapsedMs = performance.now() - state.runStartMs;
  // Step immediately on entry so the first tap produces visible motion.
  lastStepAt = 0;
  stepRewindLoop();
}

function stepRewindLoop(): void {
  if (!state.rewinding || !state.gb) return;
  const now = performance.now();
  if (now - lastStepAt >= STEP_MS) {
    const restored = state.rewinder?.step();
    if (restored) {
      // Roll the UI counters back to match the snapshot just restored —
      // otherwise the elapsed clock would keep ticking forward while
      // the game itself jumps backwards. `state.frameCount` stays in
      // sync too (consumed by the debugger pane + future snapshots),
      // even though the strip no longer displays it.
      state.frameCount = restored.meta.frameCount;
      state.runStartMs = performance.now() - restored.meta.elapsedMs;
      if (timeEl) timeEl.textContent = formatTime(restored.meta.elapsedMs / 1000);
      // Render the captured framebuffer from the snapshot rather than
      // the engine's live one — loadState restores VRAM/OAM/regs but
      // not the pre-rendered pixel buffer, so the live framebuffer
      // would still show the pre-rewind frame. Using the captured copy
      // gives the user a real preview of where in history they landed.
      renderer.render(restored.meta.framebuffer);
      // Surface the scrub distance in the overlay so the user can
      // judge when to let go. One decimal keeps the label steady at
      // the 200 ms step cadence (values update at 5 Hz).
      if (overlayRewind) {
        const deltaSec = (rewindStartElapsedMs - restored.meta.elapsedMs) / 1000;
        overlayRewind.dataset.delta = `-${deltaSec.toFixed(1)}s`;
      }
    }
    lastStepAt = now;
  }
  state.rewindRaf = requestAnimationFrame(stepRewindLoop);
}

export async function endRewind(): Promise<void> {
  const gb = state.gb;
  if (!state.rewinding || !gb) return;
  cancelAnimationFrame(state.rewindRaf);
  state.rewinding = false;
  overlayRewind?.classList.remove("active");
  if (overlayRewind) delete overlayRewind.dataset.delta;
  announce("Rewind stopped");
  state.rewinder?.start();
  if (statusEl) statusEl.textContent = state.paused ? "Paused" : "Running";
  if (!state.paused) {
    await audio.resume();
    startPacing(gb);
  }
}
