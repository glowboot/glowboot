import { type BreakpointHit, takeHit } from "../../gb";
import { parseGbaHeader } from "../../gba";
import { canvas, consoleEl, fsBtn, overlayFlash, recBadge, speedEl, statusEl, touchSpeedLabelEl } from "../dom.js";
import { announce } from "../hud/announce.js";
import { toast } from "../hud/toast.js";
import { audio, renderer, setPaused, state } from "../state.js";
import { startPacing, stopPacing } from "./pacing.js";
import { flushPlayTime, startPlayTimer } from "./play-time.js";
import { Recorder } from "./recording.js";
import { pauseGbaSession, resumeGbaSession } from "./runtime-gba.js";
import * as Screenshot from "./screenshot.js";
import { isScreenshotPreviewOpen, openScreenshotPreview } from "./screenshot-preview.js";

/** Cart title for the currently-loaded ROM, suitable for embedding
 *  in a screenshot / recording filename. Prefers the GB cart's
 *  header title, then the GBA header title (parsed lazily from ROM
 *  bytes — `Gba` doesn't surface a pre-parsed `title` field), then a
 *  generic fallback. The Screenshot.sanitize step handles unicode +
 *  whitespace + filesystem-unsafe characters downstream. */
function cartTitleForFilename(): string {
  if (state.gb) return state.gb.cart.title || "gameboy";
  if (state.gba) return parseGbaHeader(state.gba.mem.rom).title || "gba";
  return "game";
}

/** Pause / resume, turbo, screenshot, and the fullscreen button — the
 *  "runtime control" actions that are triggered either by the keyboard
 *  hotkey layer (see `keyboard.ts`) or direct UI buttons. */

export async function togglePause(): Promise<void> {
  const gb = state.gb;
  const gba = state.gba;
  if (!gb && !gba) return;
  if (state.paused) {
    if (gb) {
      // Credit MBC3 RTC for the pause gap — a real cart keeps ticking
      // while the console is off, so Pokémon G/S berries / day-night
      // cycle reflect real elapsed time rather than emulated CPU time
      // only. GBA has no realtime clock so this branch is GB-only.
      if (state.rtcWallPauseMs > 0) {
        gb.cart.advanceRtcByWallMs(Date.now() - state.rtcWallPauseMs);
        state.rtcWallPauseMs = 0;
      }
      await audio.resume();
      startPacing(gb);
    } else if (gba) {
      // GBA has no RTC catch-up; just resume the rAF + audio context.
      state.rtcWallPauseMs = 0;
      await audio.resume();
      resumeGbaSession();
    }
    if (statusEl) statusEl.textContent = "Running";
    startPlayTimer();
    announce("Resumed");
  } else {
    // Only stamp the RTC pause marker when a GB cart is loaded — GBA
    // carts don't consume it and a stale stamp could leak forward to a
    // future GB cart load if it weren't cleared on cart swap.
    if (gb && state.rtcWallPauseMs === 0) state.rtcWallPauseMs = Date.now();
    if (gb) stopPacing();
    else pauseGbaSession();
    await audio.suspend();
    if (statusEl) statusEl.textContent = "Paused";
    void flushPlayTime();
    announce("Paused");
  }
  setPaused(!state.paused);
}

/** Cycle through the available emulation speeds in order. Audio is only
 *  resumed at 1× because the sample scheduler is pinned to wall time —
 *  any other multiplier drops / duplicates samples and produces
 *  glitching. */
const SPEED_STEPS: readonly number[] = [0.5, 1, 2, 4];

/** Step through SPEED_STEPS. `direction` is +1 by default (a plain
 *  turbo press); pass -1 (Shift+turbo) to walk backwards so the user
 *  can back out of a 4× commitment without cycling through 0.5×. */
export function cycleSpeed(direction: 1 | -1 = 1): void {
  const engine = state.gb ?? state.gba;
  if (!engine) return;
  const len = SPEED_STEPS.length;
  const currentIdx = SPEED_STEPS.indexOf(engine.speedMultiplier);
  const next = SPEED_STEPS[(currentIdx + direction + len) % len]!;
  applySpeed(next);
}

function applySpeed(speed: number): void {
  const engine = state.gb ?? state.gba;
  if (!engine) return;
  engine.speedMultiplier = speed;
  if (speed === 1) void audio.resume();
  else void audio.suspend();
  if (speedEl) {
    speedEl.textContent = `×${speed}`;
    // Show at any non-1x multiplier via a class toggle so the base
    // CSS owns the display mode — no inline styles leak into the
    // DOM at session-hot paths.
    speedEl.classList.toggle("is-on", speed !== 1);
    // Slow-mo and turbo use different accent colours so the user can
    // tell them apart at a glance without reading the multiplier.
    speedEl.classList.toggle("slow", speed < 1);
  }
  // Mirror the multiplier into the touch toolbar's speed button so
  // mobile players can read the active speed without scanning the
  // header strip. CSS swaps the FF icon for this label whenever
  // `#np-speed.is-on` is set.
  if (touchSpeedLabelEl) touchSpeedLabelEl.textContent = speed === 1 ? "" : `×${speed}`;
  announce(speed === 1 ? "Normal speed" : `Speed ${speed}x`);
}

/** Run exactly one engine frame without unpausing the pacing loop. Auto-
 *  pauses first if the game is running so the user can tap the hotkey
 *  without a separate Space press. `runFrame()` fires the engine's
 *  `onFrame` callback which already renders and bumps the NP strip via
 *  `tickStatus`, so this function deliberately only triggers the step;
 *  incrementing / re-rendering here would double the effect. */
export function frameAdvance(): void {
  const gb = state.gb;
  const gba = state.gba;
  if (!gb && !gba) return;
  if (!state.paused) {
    // First tap auto-pauses so the user doesn't have to press Space
    // before starting to step.
    if (gb) stopPacing();
    else pauseGbaSession();
    void audio.suspend();
    // GBA has no RTC catch-up; only the GB branch stamps the marker.
    if (gb && state.rtcWallPauseMs === 0) state.rtcWallPauseMs = Date.now();
    if (statusEl) statusEl.textContent = "Paused";
    void flushPlayTime();
    setPaused(true);
  }
  if (gb) gb.stepFrame();
  else gba!.stepFrame();
}

/** Single-instruction step — debugger's finest-grained control. Auto-
 *  pauses on first press (same convention as `frameAdvance`). The
 *  engine-side `stepInstruction` runs one opcode plus proportional
 *  subsystem work; the host renders whatever partial framebuffer
 *  resulted so visual progress is visible. */
export function stepInstruction(): void {
  const gb = state.gb;
  const gba = state.gba;
  if (!gb && !gba) return;
  if (!state.paused) {
    if (gb) stopPacing();
    else pauseGbaSession();
    void audio.suspend();
    if (gb && state.rtcWallPauseMs === 0) state.rtcWallPauseMs = Date.now();
    if (statusEl) statusEl.textContent = "Paused";
    void flushPlayTime();
    setPaused(true);
  }
  if (gb) {
    gb.stepInstruction();
    // Paint the framebuffer directly rather than through `gb.onFrame`,
    // because that callback also bumps `state.frameCount` via tickStatus
    // — and a single-instruction step isn't a new frame. The Step frame
    // button (which calls runFrame) goes through onFrame as usual.
    renderer.render(gb.ppu.framebuffer);
  } else {
    gba!.stepInstruction();
    renderer.render(gba!.framebuffer);
  }
}

/**
 * Drain the breakpoint registry's pending hit. Called once per frame
 * from the pacing loop; if something fired, auto-pause the emulator
 * and toast the user with the kind + address of the hit.
 */
export function drainBreakpointHit(): BreakpointHit | null {
  const hit = takeHit();
  if (!hit) return null;
  if (!state.paused) {
    stopPacing();
    void audio.suspend();
    if (state.rtcWallPauseMs === 0) state.rtcWallPauseMs = Date.now();
    if (statusEl) statusEl.textContent = "Paused";
    void flushPlayTime();
    setPaused(true);
  }
  const hex = "$" + hit.addr.toString(16).toUpperCase().padStart(4, "0");
  const label = hit.kind === "pc" ? "Breakpoint" : hit.kind === "read" ? "Watch (read)" : "Watch (write)";
  toast(`${label} @ ${hex}`);
  announce(`${label} at ${hex}`);
  return hit;
}

/** Rewind by exactly one captured snapshot. The rewind buffer stores
 *  at most one snapshot per second (see `RewindBuffer`), so this is
 *  coarser than `frameAdvance`'s forward step — but it's the only
 *  "go back" granularity the engine has. */
export function stepFrameBack(): void {
  const gb = state.gb;
  if (!gb || !state.rewinder) return;
  if (!state.paused) {
    stopPacing();
    void audio.suspend();
    if (state.rtcWallPauseMs === 0) state.rtcWallPauseMs = Date.now();
    if (statusEl) statusEl.textContent = "Paused";
    void flushPlayTime();
    setPaused(true);
  }
  const popped = state.rewinder.step();
  if (!popped) {
    toast("No more rewind history");
    return;
  }
  state.frameCount = popped.meta.frameCount;
  state.runStartMs = performance.now() - popped.meta.elapsedMs;
  // The rewound save-state already restored PPU + APU state; paint
  // the cached framebuffer from the snapshot so the display reflects
  // the restored moment instead of the live (now-undone) frame.
  renderer.render(popped.meta.framebuffer as Uint8ClampedArray<ArrayBuffer>);
}

export function takeScreenshot(): void {
  // Ignore a repeat trigger while the preview is up — the game is paused
  // under it and re-entering would tangle the pause/resume bookkeeping.
  if (isScreenshotPreviewOpen()) return;
  // Capture the NATIVE PPU framebuffer (not the shader-displayed canvas):
  // a pixel-exact source for the preview, and the un-double-processed
  // input the AI-enhance path needs. GB is 160×144, GBA 240×160.
  const fb = state.gb ? state.gb.ppu.framebuffer : state.gba ? state.gba.framebuffer : null;
  if (!fb) return;
  const width = state.gb ? 160 : 240;
  const height = state.gb ? 144 : 160;
  overlayFlash?.classList.add("active");
  setTimeout(() => overlayFlash?.classList.remove("active"), 120);
  const base = Screenshot.sanitize(cartTitleForFilename());
  const iso = new Date().toISOString().replace(/[:.]/g, "-");

  // Pause while the modal is up so the game can't advance (and the
  // player can't die) behind the blocking overlay. Only auto-resume if
  // WE paused — a pre-existing manual pause must survive the modal.
  const pausedForModal = !state.paused;
  if (pausedForModal) void togglePause();

  // Copy the buffer — the engine reuses it for the next frame.
  openScreenshotPreview(
    new Uint8ClampedArray(fb.subarray(0, width * height * 4)),
    width,
    height,
    `${base}-${iso}`,
    () => {
      if (pausedForModal && state.paused) void togglePause();
    }
  );
}

/** Single session-wide recorder — starting while active is a stop, so the
 *  `V` hotkey and any future UI button share the same toggle semantics. */
const recorder = new Recorder();

export function toggleRecording(): void {
  if (!state.gb && !state.gba) return;
  if (recorder.active) {
    recorder.stop();
    recBadge?.classList.remove("rec-badge--on");
    toast("Recording saved");
    return;
  }
  const base = Screenshot.sanitize(cartTitleForFilename());
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const audioStream = audio.createRecordingTap();
  const ok = recorder.start(canvas, audioStream, `${base}-${iso}`);
  if (!ok) {
    toast("Recording not supported in this browser");
    return;
  }
  recBadge?.classList.add("rec-badge--on");
  toast("Recording…");
}

fsBtn?.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  // Fullscreen the .console wrapper (canvas + touch overlay) so
  // on-screen controls stay available for touch users; fullscreening
  // just the canvas would hide everything else in the DOM.
  else consoleEl?.requestFullscreen?.();
});
