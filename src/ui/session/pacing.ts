import { FRAMES_PER_SEC, type GameBoy, peekHit } from "../../gb";
import { state } from "../state.js";
import { drainBreakpointHit } from "./actions.js";

/**
 * requestAnimationFrame-driven pacer for the Game Boy / Game Boy Color
 * engine. The Game Boy Advance engine has its own pacer at
 * `./runtime-gba.ts` (with sub-frame chunked execution + SIO
 * activity-gated yields for the link-cable path). Both sit in the UI
 * layer (not the engine) so `src/gb/` and `src/gba/` stay host-
 * agnostic — the engines expose only `runFrame()` and the schedulers
 * decide when to call them.
 *
 * The pacer targets wall-clock time rather than the display's rAF rate,
 * so a 120 Hz / 144 Hz monitor doesn't make the emulator run too fast.
 * Each rAF callback accumulates `elapsed * speedMultiplier` milliseconds
 * into a budget and calls `runFrame` as many whole frames as fit into
 * it. A cap prevents a backgrounded tab from triggering a massive
 * catch-up burst when it resumes.
 */

const MS_PER_FRAME = 1000 / FRAMES_PER_SEC;

let animFrameId = 0;
let running = false;
let lastTimeMs = 0;
let accumMs = 0;

export function startPacing(gb: GameBoy): void {
  if (running) return;
  running = true;
  lastTimeMs = performance.now();
  accumMs = 0;
  scheduleFrame(gb);
}

export function stopPacing(): void {
  running = false;
  cancelAnimationFrame(animFrameId);
}

function scheduleFrame(gb: GameBoy): void {
  animFrameId = requestAnimationFrame((now) => {
    if (!running) return;

    const elapsed = now - lastTimeMs;
    lastTimeMs = now;
    // Scale the elapsed budget by the turbo multiplier so the pacer runs
    // N frames of emulation per wall-clock frame. speedMultiplier=1 is
    // the normal pacing; higher values = faster emulator.
    accumMs += elapsed * gb.speedMultiplier;
    // Cap so a backgrounded tab doesn't cause a huge catch-up burst on
    // return. At 4× turbo that's still 16 frames of worst-case catch-up.
    const capFrames = 4 * Math.max(1, gb.speedMultiplier);
    if (accumMs > MS_PER_FRAME * capFrames) accumMs = MS_PER_FRAME * capFrames;

    while (accumMs >= MS_PER_FRAME) {
      const cycles = gb.runFrame();
      // Feed the HUD's GB-CPU-load accumulator. `gb.cpu.haltedCycles` is
      // reset at the top of every runFrame, so this captures one frame
      // of cycle accounting. `tickStatus` drains both fields on its
      // 250 ms display tick.
      state.cpuCyclesAcc += cycles;
      state.haltedCyclesAcc += gb.cpu.haltedCycles;
      accumMs -= MS_PER_FRAME;
      // Debugger breakpoint / watchpoint fired inside runFrame — drop
      // the remaining frame budget so we don't burn through another
      // 3 frames before the auto-pause takes effect.
      if (peekHit() !== null) {
        drainBreakpointHit();
        accumMs = 0;
        return;
      }
    }
    scheduleFrame(gb);
  });
}
