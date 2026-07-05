/**
 * rAF loop for the SNES engine — parallel to `runtime-nes.ts`. Wall-clock
 * paced at the NTSC field rate; the core exposes only `runFrame()` + a
 * framebuffer, so rendering happens here after each burst.
 *
 * Audio: the S-DSP synthesizes interleaved int16 stereo at the hardware's
 * fixed 32.04 kHz (one sample per 32 SPC cycles of the APU's own crystal)
 * into a drainable ring. Each tick drains it, linearly resamples to the
 * AudioContext rate, and schedules the result — the same scheduled-buffer
 * path the other engines use.
 */

import { type Snes } from "../../snes";
import type { AudioOutput } from "../audio/output.js";
import { tickStatus } from "../hud/status.js";
import { renderer } from "../state.js";

// 24606720 Hz APU crystal / 24 clocks per SPC cycle / 32 cycles per sample.
const DSP_RATE = 32040;

/** Linear 32.04 kHz → context-rate resampler with cross-drain continuity
 *  (keeps the previous source frame so interpolation never restarts). */
class SnesAudioPump {
  private readonly drainBuf = new Int16Array(16384);
  private readonly outL: Float32Array;
  private readonly outR: Float32Array;
  private readonly step: number;
  private prevL = 0;
  private prevR = 0;
  private frac = 1; // start past the carried frame so the first drain seeds it

  constructor(private readonly audio: AudioOutput) {
    this.step = DSP_RATE / audio.sampleRate;
    const maxOut = Math.ceil(this.drainBuf.length / 2 / this.step) + 8;
    this.outL = new Float32Array(maxOut);
    this.outR = new Float32Array(maxOut);
  }

  pump(snes: Snes): void {
    const n = snes.drainAudio(this.drainBuf);
    const frames = n >> 1;
    if (frames === 0) return;
    let out = 0;
    let src = 0;
    let frac = this.frac;
    let prevL = this.prevL;
    let prevR = this.prevR;
    while (src < frames) {
      const curL = this.drainBuf[src * 2]! / 32768;
      const curR = this.drainBuf[src * 2 + 1]! / 32768;
      while (frac < 1 && out < this.outL.length) {
        this.outL[out] = prevL + (curL - prevL) * frac;
        this.outR[out] = prevR + (curR - prevR) * frac;
        out++;
        frac += this.step;
      }
      frac -= 1;
      prevL = curL;
      prevR = curR;
      src++;
    }
    this.frac = frac;
    this.prevL = prevL;
    this.prevR = prevR;
    if (out > 0) this.audio.schedule(this.outL, this.outR, out);
  }
}

const MAX_CATCHUP_FRAMES = 4;

let activeFrameId = 0;
let stopActive: (() => void) | null = null;
let pauseActive: (() => void) | null = null;
let resumeActive: (() => void) | null = null;

export function startSnesSession(snes: Snes, audio?: AudioOutput): () => void {
  if (stopActive) stopActive();
  const pump = audio ? new SnesAudioPump(audio) : null;

  // `body.is-snes` drives the 8:7 aspect-ratio CSS for the 256×224 output.
  document.body.classList.add("is-snes");

  let running = true;
  let paused = false;
  let lastNow = performance.now();
  let frameDebt = 0;

  const tick = (now: number): void => {
    if (!running || paused) return;
    const frameMs = 1000 / snes.framesPerSec;
    const accumulated = frameDebt + ((now - lastNow) / frameMs) * snes.speedMultiplier;
    lastNow = now;
    const cap = MAX_CATCHUP_FRAMES * Math.max(1, snes.speedMultiplier);
    let toRun = Math.floor(accumulated);
    frameDebt = accumulated - toRun;
    if (toRun > cap) {
      toRun = cap;
      frameDebt = 0;
    }
    if (toRun > 0) {
      for (let i = 0; i < toRun; i++) snes.runFrame();
      pump?.pump(snes);
      renderer.render(snes.framebuffer as Uint8ClampedArray<ArrayBuffer>);
      tickStatus(now);
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
    lastNow = performance.now();
    frameDebt = 0;
    activeFrameId = requestAnimationFrame(tick);
  };

  const stop = (): void => {
    running = false;
    cancelAnimationFrame(activeFrameId);
    document.body.classList.remove("is-snes");
    if (stopActive === stop) stopActive = null;
    pauseActive = null;
    resumeActive = null;
  };
  stopActive = stop;
  return stop;
}

/** Pause the active SNES rAF loop without tearing it down. */
export function pauseSnesSession(): void {
  pauseActive?.();
}
/** Resume a paused SNES session; resets the wall-clock anchor. */
export function resumeSnesSession(): void {
  resumeActive?.();
}
/** Stop any active SNES session. */
export function stopSnesSession(): void {
  stopActive?.();
}
