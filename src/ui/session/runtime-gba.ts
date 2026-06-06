/**
 * rAF loop for the GBA engine. Sits parallel to `pacing.ts` rather
 * than collapsing into it — the two engines have meaningfully
 * different internals (sub-frame chunked execution + SIO activity-
 * gated yield here, single-shot `runFrame()` per tick there), and
 * keeping them separate avoids loading the GB engine into the test
 * environment when only the GBA pacer is under test.
 *
 * Already wired through the shared infrastructure: `speedMultiplier`
 * (drives `nextFrameBudget`), audio (`gba.onAudioFrame` →
 * `audio.schedule`), HUD plumbing (`tickStatus` drains
 * `cpuCyclesAcc` / `haltedCyclesAcc` into the CPU-load gauge). What's
 * still GB-only: the breakpoint-pause path (`peekHit` /
 * `drainBreakpointHit` — GBA debugger has its own breakpoint
 * registries but they don't pause the runtime yet).
 *
 * Painting is delegated to the shared renderer abstraction (Canvas 2D /
 * WebGL) — the caller is expected to have called `swapRenderer` with
 * GBA dimensions before starting a session so the renderer's backing
 * canvas matches the 240×160 framebuffer.
 */

import type { Gba } from "../../gba";
import type { AudioOutput } from "../audio/output.js";
import { tickStatus } from "../hud/status.js";
import { renderer, state } from "../state.js";
import { nextFrameBudget } from "./pacing-gba.js";

let activeFrameId = 0;
let stopActive: (() => void) | null = null;
/** rAF resume hook installed by the active session, called by
 *  {@link resumeGbaSession}. Cleared on `stopActive`. */
let resumeActive: (() => void) | null = null;
/** rAF pause hook installed by the active session, called by
 *  {@link pauseGbaSession}. Cleared on `stopActive`. */
let pauseActive: (() => void) | null = null;

/** Start a wall-clock-paced session: aim for one `gba.runFrame()` per
 *  ~16.743 ms of real time (real GBA refresh = 59.7275 Hz, per GBATEK),
 *  regardless of the display's refresh rate.
 *  Each rAF tick computes how many emulator frames are due based on
 *  the elapsed time and runs that many (capped at MAX_CATCHUP_FRAMES
 *  to limit the audio glitch after a stall).
 *
 *  Previous version was rAF-rate-bound — on a 120 Hz / 144 Hz display
 *  that ran the emulator at 2-2.4× real-time, which doubled audio
 *  output rate and made the AudioContext push samples too fast (audible
 *  as a pitched-up, distorted track). */
export function startGbaSession(gba: Gba, audio?: AudioOutput): () => void {
  if (stopActive) stopActive();

  // Flip the page's aspect-ratio variables to GBA (3:2). canvas.css
  // keys off `body.is-gba` to widen `.canvas-wrap` + `#screen` so the
  // 240×160 framebuffer isn't letterboxed in a 10:9 (GB) container.
  document.body.classList.add("is-gba");

  let running = true;
  // Live `renderer` import — `renderer.render` reads the current binding
  // every frame, so a settings-popover render-mode swap (which replaces
  // the renderer instance) hot-swaps transparently without rewiring.
  gba.onFrame = (fb) => {
    renderer.render(fb);
    tickStatus(performance.now());
  };
  if (audio) {
    gba.apu.sampleRate = audio.sampleRate;
    gba.onAudioFrame = (left, right, count) => audio.schedule(left, right, count);
  }

  // Wall-clock pacing: accumulate elapsed real-time since the last
  // run and convert it to whole emulator frames. The fractional
  // remainder carries over so we don't drop or duplicate frames on
  // displays whose refresh isn't a multiple of the GBA's 59.7275 Hz.
  // `speedMultiplier` scales the budget so 2× / 4× turbo and 0.5×
  // slow-mo behave the same as the GB pacer's equivalent in `pacing.ts`.
  let lastNow = performance.now();
  let frameDebt = 0;
  let paused = false;
  let loggedPairedState: boolean | null = null;
  // Sub-frame chunk size for paired Multi-Pak sessions — see
  // `runFrameChunked` below for why. 14000 cycles ≈ 2 SIO transfer
  // windows; ~20 yields per frame. Empirically `scheduler.yield()`
  // costs ~1 ms per call even in Chromium under cross-tab BC
  // pressure (the messaging-task-source drain isn't free) — 94
  // yields/frame setups (chunk = 3000) drop to 10-12 fps. 20 yields
  // fits comfortably in the 16.67 ms frame budget while still
  // giving the master peer-queue at least one BC drain per ~0.7 ms
  // of real wall time, well within typical BC delivery latency.
  const SIO_CHUNK_CYCLES = 14000;
  const CYCLES_PER_FRAME = 280896;

  /** Yield to the browser's task queue so a BroadcastChannel
   *  `message` event from the paired peer can fire its handler.
   *
   *  `queueMicrotask` is NOT sufficient — BC messages dispatch on
   *  the "messaging task source" (a macrotask). The two viable
   *  primitives for "yield exactly one task without a 4 ms
   *  setTimeout clamp" are:
   *    - `scheduler.yield()` — modern W3C scheduling API. Chromium
   *      ships this and it's optimised for high-frequency yielding
   *      (~µs overhead per call).
   *    - `MessageChannel` round-trip — universal fallback. Browser
   *      task scheduling adds ~1 ms per yield in practice, which
   *      caps us at ~16 yields per frame before the budget blows.
   *
   *  Prefer scheduler.yield when available; fall back to
   *  MessageChannel otherwise (Safari, older Firefox). The
   *  MessageChannel path will degrade fps in heavy-yield modes —
   *  acceptable since the primary deploy target is Chromium-based
   *  browsers where the fast path applies. */
  const schedulerYield = (
    globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler?.yield?.bind((globalThis as unknown as { scheduler: { yield: () => Promise<void> } }).scheduler);
  const yieldChannel = new MessageChannel();
  let pendingYield: (() => void) | null = null;
  yieldChannel.port2.onmessage = (): void => {
    const cb = pendingYield;
    pendingYield = null;
    cb?.();
  };
  const yieldToTaskQueue = schedulerYield
    ? (): Promise<void> => schedulerYield()
    : (): Promise<void> =>
        new Promise<void>((resolve) => {
          pendingYield = resolve;
          yieldChannel.port1.postMessage(null);
        });

  /** Run one emulated frame in `SIO_CHUNK_CYCLES`-sized pieces.
   *  Between chunks, yield to the browser's task queue ONLY when
   *  the SIO had real transfer activity (master pulsed BUSY 0→1,
   *  or slave received a multi-result from the peer). Without this
   *  gating we'd burn ~20 yields/frame at ~ms each just because
   *  the cart polls the link registers — `paired-mode` would drop
   *  to ~10 fps even with the cart sitting in a menu. With it,
   *  idle frames cost 0 yields (same wall time as atomic runFrame),
   *  active-transfer frames cost ~5-10 yields = ~5-10 ms overhead.
   *
   *  When the cart IS actively transferring, the yields between
   *  chunks drain BC msgs from the peer tab, keeping master's
   *  per-slot queue populated for the per-transfer pop model.
   *  Skipping cable-detect's same-frame round-trips → hang on
   *  "WAITING FOR LINK..." again. */
  const runFrameChunked = async (skipRender: boolean): Promise<number> => {
    gba.cpu.haltedCycles = 0;
    let cycles = 0;
    const sio = gba.sio;
    while (cycles < CYCLES_PER_FRAME || gba.mem.ppu.vcount < 160) {
      const budget = Math.min(SIO_CHUNK_CYCLES, CYCLES_PER_FRAME - cycles);
      cycles += gba.runForCycles(budget > 0 ? budget : SIO_CHUNK_CYCLES);
      if (sio.activityFlag) {
        sio.activityFlag = false;
        await yieldToTaskQueue();
      }
    }
    gba.finishFrame(skipRender);
    return cycles;
  };

  const tick = async (now: number): Promise<void> => {
    if (!running || paused) return;
    const { toRun, newDebt } = nextFrameBudget(now - lastNow, frameDebt, gba.speedMultiplier);
    lastNow = now;
    frameDebt = newDebt;
    // Adaptive frame skip: when we're running a catch-up burst
    // (toRun > 1, after a stall or on a device that can't keep up),
    // skip rendering for every frame except the last. CPU / APU /
    // timer / DISPSTAT IRQs all tick normally; only per-scanline
    // pixel painting is bypassed. The host sees the catch-up's
    // final framebuffer, audio stays at real-time.
    //
    // Run mode: when a Multi-Pak link is paired, use the chunked
    // path. It self-gates internally on `sio.activityFlag` — idle
    // chunks skip the yield, so a cart sitting in a menu with the
    // link paired pays no per-chunk yield overhead. Single-player
    // and unpaired sessions use the atomic `runFrame` — slightly
    // tighter still (no chunk loop at all).
    const paired = state.gbaLink?.paired === true;
    if (paired !== loggedPairedState) {
      loggedPairedState = paired;
      console.info(
        `[GBA link] paired=${paired} — using ${paired ? "chunked sub-frame (yield-on-activity)" : "atomic runFrame"} path`
      );
    }
    for (let i = 0; i < toRun; i++) {
      const skipRender = i < toRun - 1;
      const cycles = paired ? await runFrameChunked(skipRender) : gba.runFrame(skipRender);
      if (!running || paused) return;
      // Feed the HUD's CPU-load accumulator. `gba.cpu.haltedCycles`
      // is reset at the top of every frame, so each iteration
      // captures one frame of cycle accounting. `tickStatus` drains
      // both fields on its 250 ms display tick.
      state.cpuCyclesAcc += cycles;
      state.haltedCyclesAcc += gba.cpu.haltedCycles;
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
    // Reset the wall-clock anchor so the pause gap doesn't trigger a
    // catch-up burst on the first post-resume rAF tick.
    lastNow = performance.now();
    frameDebt = 0;
    activeFrameId = requestAnimationFrame(tick);
  };

  const stop = (): void => {
    running = false;
    cancelAnimationFrame(activeFrameId);
    yieldChannel.port1.close();
    yieldChannel.port2.close();
    pendingYield = null;
    gba.onFrame = null;
    gba.onAudioFrame = null;
    document.body.classList.remove("is-gba");
    if (stopActive === stop) stopActive = null;
    pauseActive = null;
    resumeActive = null;
  };
  stopActive = stop;
  return stop;
}

/** Halt the active GBA session's rAF loop without tearing the callbacks
 *  down — the inverse of {@link resumeGbaSession}. Used by the Pause
 *  hotkey so the user can step away without losing the is-gba body
 *  class (which drives the 3:2 aspect-ratio CSS) or the current
 *  `onFrame` / `onAudioFrame` wiring. No-op when nothing is running. */
export function pauseGbaSession(): void {
  pauseActive?.();
}

/** Resume a previously {@link pauseGbaSession}-d session. The wall-
 *  clock anchor resets so the elapsed pause doesn't fire a catch-up
 *  burst. No-op when no session is running or none is paused. */
export function resumeGbaSession(): void {
  resumeActive?.();
}

/** Stop any active GBA session. The renderer abstraction owns canvas
 *  sizing — callers transitioning back to a GB cart re-`swapRenderer`
 *  with GB dimensions, so we don't touch the canvas here. */
export function stopGbaSession(): void {
  stopActive?.();
}
