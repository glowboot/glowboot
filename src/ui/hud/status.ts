import { fpsEl, statusEl, timeEl, titleEl } from "../dom.js";
import { formatTime } from "../format.js";
import { state } from "../state.js";

/**
 * Live NOW-PLAYING status strip: FPS gauge + elapsed time. Counters
 * live on the shared `state` object so the rewind loop can roll them
 * backwards in lockstep with the engine.
 *
 * The 250 ms tick also drains `cpuCyclesAcc` / `haltedCyclesAcc` (fed
 * by the pacer) into `state.cpuLoadPct` — the debugger CPU pane reads
 * that. We compute it here rather than in the pane so the value keeps
 * updating at a stable cadence regardless of whether the debugger is
 * open.
 */

export function tickStatus(nowMs: number): void {
  state.frameCount++;
  state.fpsFrames++;
  if (nowMs - state.fpsLastMs >= 250) {
    const fps = (state.fpsFrames * 1000) / (nowMs - state.fpsLastMs);
    if (fpsEl) fpsEl.textContent = `${fps.toFixed(1)} fps`;
    const total = state.cpuCyclesAcc;
    const idle = state.haltedCyclesAcc;
    state.cpuLoadPct = total > 0 ? Math.max(0, Math.min(100, Math.round((100 * (total - idle)) / total))) : 0;
    state.fpsLastMs = nowMs;
    state.fpsFrames = 0;
    state.cpuCyclesAcc = 0;
    state.haltedCyclesAcc = 0;
  }
  if (timeEl) timeEl.textContent = formatTime((nowMs - state.runStartMs) / 1000);
}

export function resetStatus(title: string): void {
  state.frameCount = 0;
  state.fpsFrames = 0;
  state.runStartMs = performance.now();
  state.fpsLastMs = state.runStartMs;
  state.cpuCyclesAcc = 0;
  state.haltedCyclesAcc = 0;
  state.cpuLoadPct = 0;
  // Starting a fresh cart resets the "how long since last state save"
  // timer used by doLoadState's overwrite prompt — new session, no
  // unsaved progress yet.
  state.lastStateAt = 0;
  if (titleEl) titleEl.textContent = title;
  if (statusEl) statusEl.textContent = "Running";
  if (fpsEl) fpsEl.textContent = "0.0 fps";
  if (timeEl) timeEl.textContent = "00:00";
}
