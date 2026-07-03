/**
 * rAF loop for the NES engine. Parallel to `pacing.ts` (GB) and
 * `runtime-gba.ts` (GBA) — the NES core is host-agnostic and exposes only
 * `runFrame()` + an `onFrame` callback, so the scheduler lives here in the UI
 * layer.
 *
 * Wall-clock paced (not rAF-rate bound) so a 120/144 Hz display doesn't run the
 * emulator too fast: each tick converts elapsed real time into whole NES frames
 * — at the cart's region rate (60.0988 Hz NTSC / 50.0070 Hz PAL) — carrying the
 * fractional remainder and capping the catch-up burst after a stall.
 */

import { type Nes } from "../../nes";
import type { AudioOutput } from "../audio/output.js";
import { tickStatus } from "../hud/status.js";
import { renderer } from "../state.js";
import { drainBreakpointHit } from "./actions.js";

const MAX_CATCHUP_FRAMES = 4;

let activeFrameId = 0;
let stopActive: (() => void) | null = null;
let pauseActive: (() => void) | null = null;
let resumeActive: (() => void) | null = null;

export function startNesSession(nes: Nes, audio?: AudioOutput): () => void {
  if (stopActive) stopActive();

  // `body.is-nes` drives the 8:7.5 aspect-ratio CSS so the 256×240 framebuffer
  // isn't letterboxed in the GB (10:9) container.
  document.body.classList.add("is-nes");

  let running = true;
  let paused = false;
  let lastNow = performance.now();
  let frameDebt = 0;

  // Live `renderer` import so a settings render-mode swap hot-swaps the
  // instance without rewiring.
  nes.onFrame = (fb) => {
    renderer.render(fb);
    tickStatus(performance.now());
  };
  if (audio) {
    nes.apu.sampleRate = audio.sampleRate;
    nes.onAudioFrame = (left, right, count) => audio.schedule(left, right, count);
  }

  const tick = (now: number): void => {
    if (!running || paused) return;
    // Read the cart's frame interval each tick so a live NTSC/PAL region
    // switch retimes the pacer immediately.
    const frameMs = 1000 / nes.framesPerSec;
    const accumulated = frameDebt + ((now - lastNow) / frameMs) * nes.speedMultiplier;
    lastNow = now;
    const cap = MAX_CATCHUP_FRAMES * Math.max(1, nes.speedMultiplier);
    let toRun = Math.floor(accumulated);
    frameDebt = accumulated - toRun;
    if (toRun > cap) {
      toRun = cap;
      frameDebt = 0;
    }
    for (let i = 0; i < toRun; i++) {
      nes.runFrame();
      // A breakpoint / watchpoint fired mid-frame: auto-pause at the stopped PC.
      if (drainBreakpointHit()) return;
      if (!running || paused) return;
    }
    activeFrameId = requestAnimationFrame(tick);
  };
  activeFrameId = requestAnimationFrame(tick);

  pauseActive = (): void => {
    if (paused) return;
    paused = true;
    cancelAnimationFrame(activeFrameId);
  };
  resumeActive = (): void => {
    if (!paused) return;
    paused = false;
    lastNow = performance.now(); // reset anchor so the gap isn't a catch-up burst
    frameDebt = 0;
    activeFrameId = requestAnimationFrame(tick);
  };

  const stop = (): void => {
    running = false;
    cancelAnimationFrame(activeFrameId);
    nes.onFrame = null;
    nes.onAudioFrame = null;
    document.body.classList.remove("is-nes");
    if (stopActive === stop) stopActive = null;
    pauseActive = null;
    resumeActive = null;
  };
  stopActive = stop;
  return stop;
}

/** Pause the active NES rAF loop without tearing down its callbacks. */
export function pauseNesSession(): void {
  pauseActive?.();
}
/** Resume a paused NES session; resets the wall-clock anchor. */
export function resumeNesSession(): void {
  resumeActive?.();
}
/** Stop any active NES session. */
export function stopNesSession(): void {
  stopActive?.();
}
