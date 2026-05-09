import { fpsEl, frameEl, statusEl, timeEl, titleEl } from "../dom.js";
import { formatTime } from "../format.js";
import { state } from "../state.js";

/**
 * Live NOW-PLAYING status strip: frame counter, FPS gauge, elapsed time.
 * Counters live on the shared `state` object so the rewind loop can roll
 * them backwards in lockstep with the engine.
 */

export function tickStatus(nowMs: number): void {
  state.frameCount++;
  state.fpsFrames++;
  if (frameEl) frameEl.textContent = state.frameCount.toLocaleString();
  if (nowMs - state.fpsLastMs >= 250) {
    const fps = (state.fpsFrames * 1000) / (nowMs - state.fpsLastMs);
    if (fpsEl) fpsEl.textContent = `${fps.toFixed(1)} fps`;
    state.fpsLastMs = nowMs;
    state.fpsFrames = 0;
  }
  if (timeEl) timeEl.textContent = formatTime((nowMs - state.runStartMs) / 1000);
}

export function resetStatus(title: string): void {
  state.frameCount = 0;
  state.fpsFrames = 0;
  state.runStartMs = performance.now();
  state.fpsLastMs = state.runStartMs;
  // Starting a fresh cart resets the "how long since last state save"
  // timer used by doLoadState's overwrite prompt — new session, no
  // unsaved progress yet.
  state.lastStateAt = 0;
  if (titleEl) titleEl.textContent = title;
  if (statusEl) statusEl.textContent = "Running";
  if (frameEl) frameEl.textContent = "0";
  if (fpsEl) fpsEl.textContent = "0.0 fps";
  if (timeEl) timeEl.textContent = "00:00";
}
