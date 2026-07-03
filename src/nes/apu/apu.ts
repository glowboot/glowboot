/**
 * Ricoh 2A03 APU — frame counter + the five sound channels (2 pulse, triangle,
 * noise, DMC), mixed and resampled to the host rate.
 *
 * Clocked one CPU cycle at a time: the triangle and DMC timers tick every CPU
 * cycle, the pulse/noise timers every other (APU) cycle, and the frame
 * sequencer drives the quarter-frame (envelope / linear) and half-frame
 * (length / sweep) clocks. The non-linear mixer's output is DC-blocked and
 * sampled at `sampleRate` into `outLeft`/`outRight` for the host to schedule.
 *
 * Reference: https://www.nesdev.org/wiki/APU and /APU_Mixer.
 *
 * The frame-counter and DMC IRQ flags are exposed via {@link irqState} and
 * driven onto the CPU IRQ line by {@link Nes}. The flag *value* is correct
 * ($4015 read / $4017 inhibit clear it); the exact sub-cycle the frame IRQ
 * asserts is still slightly early, so blargg's cycle-precise apu_test /
 * cpu_interrupts latency probes don't yet pass.
 */

import { REGION_TIMING, type RegionTiming } from "../region/region.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import { DmcChannel, NoiseChannel, PulseChannel, TriangleChannel } from "./channels.js";
import type { ExpansionAudio } from "./expansion.js";

const CPU_HZ = 1_789_773;

// At power-on and reset the 2A03 behaves as if $00 was written to $4017 a few
// clocks before the CPU's first instruction: the frame sequencer is already a
// short way into its period when code begins (nesdev: the effective write is
// "9-12 clocks" before the reset vector, minus the 3-4 cycle frame-counter
// reset delay). apu_reset's 4017_timing / 4017_written probe this startup phase.
const POWER_ON_FRAME_CYCLE = 5;

export class APU {
  private readonly pulse1 = new PulseChannel(true); // ch1: ones-complement sweep
  private readonly pulse2 = new PulseChannel(false); // ch2: two's-complement sweep
  private readonly triangle = new TriangleChannel();
  private readonly noise = new NoiseChannel();
  private readonly dmc: DmcChannel;

  /** Cartridge expansion sound chip, summed into the mix (null on most carts). */
  expansion: ExpansionAudio | null = null;

  /** Per-channel mute for the settings UI: [pulse1, pulse2, triangle, noise,
   *  dmc]. Default all-false, so this is inert until the user toggles a mute. */
  readonly muteChannel = [false, false, false, false, false];

  // Frame sequencer (CPU cycles).
  private frameCycle = 0;
  private frameMode = 0; // 0 = 4-step (with IRQ), 1 = 5-step
  // A $4017 write resets the sequencer only after a 3-4 CPU-cycle delay (3 if
  // the write lands on an even/APU cycle, 4 if odd) — resetting immediately
  // makes every frame event fire a few cycles early. Tracked here until it fires.
  private frameResetCountdown = 0;
  private frameIrqInhibit = false;
  private frameIrqFlag = false;
  private evenCycle = false;

  // Host-rate resampling.
  /** Mono output (duplicated L/R) for the current frame; the host reads up to
   *  `outPos` samples after each frame and resets it. */
  readonly outLeft = new Float32Array(2048);
  readonly outRight = new Float32Array(2048);
  outPos = 0;
  private cyclesPerSample = CPU_HZ / 44100;
  private hostSampleRate = 44100;
  private sampleCounter = 0;
  private hpPrev = 0;
  private hpOut = 0;

  /** Regional timing — drives cyclesPerSample (PAL's slower CPU clock), the
   *  frame-sequencer boundaries, and the noise / DMC period tables. NTSC until
   *  the owning {@link Nes} applies the cart's region via {@link setTiming}. */
  private timing: RegionTiming = REGION_TIMING.ntsc;
  /** The active frame-sequencer step table — re-derived whenever `frameMode`
   *  or the region timing changes, so the per-cycle clock doesn't reselect it. */
  private frameSeq: readonly [number, number, number, number, number] = REGION_TIMING.ntsc.apuFrameSeq4;
  /** Staged length-counter state (halt / reload writes, a half-frame's
   *  decrement mark) is pending — lets the per-cycle clock skip the four
   *  `endCycle` applies on the vast majority of cycles. */
  private lengthDirty = false;

  /** Per-channel raw-output ring buffers for the debugger's oscilloscope
   *  (4096 samples ≈ 93 ms at 44.1 kHz). Written once per emitted host
   *  sample; the size is a power of two so the wrap is a single bitwise
   *  `& DEBUG_BUFFER_MASK`. Pulse / triangle / noise are 0-15, the DMC is
   *  its 0-127 DAC level. Debug-only — never serialized. */
  private static readonly DEBUG_BUFFER_SIZE = 4096;
  private static readonly DEBUG_BUFFER_MASK = 4095;
  readonly debugPulse1 = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  readonly debugPulse2 = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  readonly debugTriangle = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  readonly debugNoise = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  readonly debugDmc = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  private debugSamplePos = 0;

  /** Peak-tracking envelope follower per channel — instant attack,
   *  exponential release — so the row's level bar holds a readable peak
   *  instead of flickering with the instantaneous output. */
  private static readonly CHAN_RELEASE = 0.9998;
  private pulse1Env = 0;
  private pulse2Env = 0;
  private triangleEnv = 0;
  private noiseEnv = 0;
  private dmcEnv = 0;

  constructor(dmcRead: (addr: number) => number) {
    this.dmc = new DmcChannel(dmcRead);
  }

  set sampleRate(rate: number) {
    this.hostSampleRate = rate;
    this.cyclesPerSample = this.timing.cpuClockHz / rate;
  }

  /** Apply NTSC / PAL timing: recompute the resample stride for the region's
   *  CPU clock and swap the noise / DMC period tables. Safe to call live. */
  setTiming(timing: RegionTiming): void {
    this.timing = timing;
    this.cyclesPerSample = timing.cpuClockHz / this.hostSampleRate;
    this.noise.setPeriods(timing.noisePeriods);
    this.dmc.setRates(timing.dmcRates);
    this.refreshFrameSeq();
  }

  private refreshFrameSeq(): void {
    this.frameSeq = this.frameMode === 0 ? this.timing.apuFrameSeq4 : this.timing.apuFrameSeq5;
  }

  reset(): void {
    this.frameCycle = POWER_ON_FRAME_CYCLE;
    this.frameMode = 0;
    this.refreshFrameSeq();
    this.frameIrqInhibit = false;
    this.frameIrqFlag = false;
    this.outPos = 0;
  }

  /** Soft reset (the RESET button): $4015 is cleared (all channels silenced,
   *  length counters zeroed) and the frame IRQ flag is cleared, while the frame
   *  counter mode last written to $4017 is retained. */
  softReset(): void {
    this.writeStatus(0);
    this.frameIrqFlag = false;
    this.dmc.irqFlag = false;
    this.frameCycle = POWER_ON_FRAME_CYCLE;
  }

  /** Advance the APU by `cpuCycles`. */
  tick(cpuCycles: number): void {
    for (let i = 0; i < cpuCycles; i++) this.clock();
  }

  /** Combined frame-IRQ + DMC-IRQ line for the CPU (see the class note on the
   *  slightly-early frame-IRQ assert timing). */
  irqState(): boolean {
    return this.frameIrqFlag || this.dmc.irqFlag;
  }

  /** Route the DMC's DMA request edge (sample buffer ran empty) to the CPU.
   *  `reload` distinguishes the constant-4-cycle reload DMA from a $4015 load. */
  set onDmcDmaRequest(fn: ((reload: boolean) => void) | null) {
    this.dmc.onDmaRequest = fn;
  }
  /** The DMA's get cycle — the CPU calls this mid-stall to deliver the byte. */
  dmcDmaFetch(): void {
    this.dmc.dmaFetch();
  }

  /** Current write position into the per-channel debug buffers; the scope
   *  view reads the last N samples ending here. */
  get debugBufferPos(): number {
    return this.debugSamplePos;
  }
  get debugBufferSize(): number {
    return APU.DEBUG_BUFFER_SIZE;
  }

  /** Per-channel envelope normalized to 0..1 (pulse / triangle / noise over
   *  15, DMC over its 127 DAC range). */
  get pulse1Envelope(): number {
    return this.pulse1Env / 15;
  }
  get pulse2Envelope(): number {
    return this.pulse2Env / 15;
  }
  get triangleEnvelope(): number {
    return this.triangleEnv / 15;
  }
  get noiseEnvelope(): number {
    return this.noiseEnv / 15;
  }
  get dmcEnvelope(): number {
    return this.dmcEnv / 127;
  }

  /** The five channels' state + frame sequencer + DC-blocker. The output ring
   *  (`outLeft`/`outRight`/`outPos`) and `cyclesPerSample` are NOT serialized —
   *  the ring is host-drained each frame and the resample rate is re-set by the
   *  host. The expansion chip is serialized by its owning mapper. */
  serialize(w: NesStateWriter): void {
    this.pulse1.serialize(w);
    this.pulse2.serialize(w);
    this.triangle.serialize(w);
    this.noise.serialize(w);
    this.dmc.serialize(w);
    w.u32(this.frameCycle);
    w.u8(this.frameMode);
    w.u8(this.frameResetCountdown);
    w.bool(this.frameIrqInhibit);
    w.bool(this.frameIrqFlag);
    w.bool(this.evenCycle);
    w.f64(this.sampleCounter);
    w.f64(this.hpPrev);
    w.f64(this.hpOut);
  }
  deserialize(r: NesStateReader): void {
    this.pulse1.deserialize(r);
    this.pulse2.deserialize(r);
    this.triangle.deserialize(r);
    this.noise.deserialize(r);
    this.dmc.deserialize(r);
    this.frameCycle = r.u32();
    this.frameMode = r.u8();
    this.refreshFrameSeq();
    // A restored state may carry staged length-counter writes — arm one apply.
    this.lengthDirty = true;
    this.frameResetCountdown = r.u8();
    this.frameIrqInhibit = r.bool();
    this.frameIrqFlag = r.bool();
    this.evenCycle = r.bool();
    this.sampleCounter = r.f64();
    this.hpPrev = r.f64();
    this.hpOut = r.f64();
    this.outPos = 0;
  }

  private clock(): void {
    this.triangle.clockTimer();
    this.dmc.clockTimer();
    if (this.expansion) this.expansion.clock();
    this.evenCycle = !this.evenCycle;
    if (this.evenCycle) {
      this.pulse1.clockTimer();
      this.pulse2.clockTimer();
      this.noise.clockTimer();
    }
    // The delayed $4017 sequencer reset lands here (the mode + 5-step clock
    // already happened at the write); otherwise advance the sequencer normally.
    if (this.frameResetCountdown > 0 && --this.frameResetCountdown === 0) {
      this.frameCycle = 0;
    } else {
      this.clockFrame();
    }
    // Apply staged length-counter halt/reload writes after the sequencer's clock
    // (changes take effect only after the length is clocked). `lengthDirty` is
    // armed by register writes and half-frame clocks — the only sources of
    // staged state — so idle cycles skip all four calls.
    if (this.lengthDirty) {
      this.pulse1.length.endCycle();
      this.pulse2.length.endCycle();
      this.triangle.length.endCycle();
      this.noise.length.endCycle();
      this.lengthDirty = false;
    }

    if (--this.sampleCounter <= 0) {
      this.sampleCounter += this.cyclesPerSample;
      this.emitSample();
    }
  }

  private emitSample(): void {
    // Read each channel once and reuse for both the debug scope and the
    // mix — the per-channel outputs are captured before the output-ring
    // fullness guard so the oscilloscope keeps advancing at the host rate.
    const m = this.muteChannel;
    const p1 = m[0] ? 0 : this.pulse1.output();
    const p2 = m[1] ? 0 : this.pulse2.output();
    const tri = m[2] ? 0 : this.triangle.output();
    const noi = m[3] ? 0 : this.noise.output();
    const dmc = m[4] ? 0 : this.dmc.output();

    const dpos = this.debugSamplePos;
    this.debugPulse1[dpos] = p1;
    this.debugPulse2[dpos] = p2;
    this.debugTriangle[dpos] = tri;
    this.debugNoise[dpos] = noi;
    this.debugDmc[dpos] = dmc;
    this.debugSamplePos = (dpos + 1) & APU.DEBUG_BUFFER_MASK;

    const r = APU.CHAN_RELEASE;
    this.pulse1Env = Math.max(p1, this.pulse1Env * r);
    this.pulse2Env = Math.max(p2, this.pulse2Env * r);
    this.triangleEnv = Math.max(tri, this.triangleEnv * r);
    this.noiseEnv = Math.max(noi, this.noiseEnv * r);
    this.dmcEnv = Math.max(dmc, this.dmcEnv * r);

    if (this.outPos >= this.outLeft.length) return;
    // One-pole DC-blocking high-pass — the real APU has high-pass filters and
    // the mixer output has a large DC offset that would otherwise clip.
    const raw = this.mix(p1, p2, tri, noi, dmc);
    const out = raw - this.hpPrev + 0.9966 * this.hpOut;
    this.hpPrev = raw;
    this.hpOut = out;
    this.outLeft[this.outPos] = out;
    this.outRight[this.outPos] = out;
    this.outPos++;
  }

  private mix(p1: number, p2: number, tri: number, noi: number, dmc: number): number {
    const pulseSum = p1 + p2;
    const pulseOut = pulseSum === 0 ? 0 : 95.88 / (8128 / pulseSum + 100);
    const tnd = tri / 8227 + noi / 12241 + dmc / 22638;
    const tndOut = tnd === 0 ? 0 : 159.79 / (1 / tnd + 100);
    const expansion = this.expansion ? this.expansion.output() : 0;
    return pulseOut + tndOut + expansion; // ~0..1 (+ expansion chip)
  }

  // ── frame sequencer ──────────────────────────────────────────────────────
  // Boundaries (CPU cycles) come from the region timing table — NTSC and PAL
  // clock the sequencer at different periods. 4-step mode raises the frame IRQ
  // at its fourth point; 5-step mode never does.
  private clockFrame(): void {
    this.frameCycle++;
    const seq = this.frameSeq;
    // In 4-step mode the frame-interrupt flag is asserted across the three CPU
    // cycles before the sequencer wraps (seq[3]-1 .. seq[4]), not just the
    // quarter/half-clock cycle — blargg's apu_test probes that exact window.
    if (this.frameMode === 0 && !this.frameIrqInhibit && this.frameCycle >= seq[3]! - 1) {
      this.frameIrqFlag = true;
    }
    if (this.frameCycle === seq[0]) {
      this.quarterFrame();
    } else if (this.frameCycle === seq[1]) {
      this.quarterFrame();
      this.halfFrame();
    } else if (this.frameCycle === seq[2]) {
      this.quarterFrame();
    } else if (this.frameCycle === seq[3]) {
      this.quarterFrame();
      this.halfFrame();
    } else if (this.frameCycle >= seq[4]) {
      // `>=` (not `===`) self-corrects a counter loaded past the wrap point —
      // e.g. a PAL save state restored after the region override changed.
      this.frameCycle = 0;
    }
  }

  private quarterFrame(): void {
    this.pulse1.clockEnvelope();
    this.pulse2.clockEnvelope();
    this.noise.clockEnvelope();
    this.triangle.clockLinear();
  }
  private halfFrame(): void {
    this.pulse1.clockLengthAndSweep();
    this.pulse2.clockLengthAndSweep();
    this.triangle.clockLength();
    this.noise.clockLength();
    // The length clocks set each counter's `decremented` mark, which the
    // same-cycle endCycle pass must consume.
    this.lengthDirty = true;
  }

  // ── register interface ($4000-$4017) ────────────────────────────────────
  writeRegister(addr: number, value: number): void {
    // Any register write may stage a length-counter halt / reload; arm the
    // per-cycle apply (a superset trigger — writes are rare, the check isn't).
    this.lengthDirty = true;
    if (addr <= 0x4003) this.pulse1.write(addr, value);
    else if (addr <= 0x4007) this.pulse2.write(addr, value);
    else if (addr <= 0x400b) this.triangle.write(addr, value);
    else if (addr <= 0x400f) this.noise.write(addr, value);
    else if (addr <= 0x4013) this.dmc.write(addr, value);
    else if (addr === 0x4015) this.writeStatus(value);
    else if (addr === 0x4017) this.writeFrameCounter(value);
  }

  /** $4015 read: length-counter status (bits 0-3), DMC active (bit 4), frame
   *  IRQ (bit 6), DMC IRQ (bit 7). Reading clears the frame IRQ flag. */
  readStatus(): number {
    let v = 0;
    if (this.pulse1.length.value > 0) v |= 0x01;
    if (this.pulse2.length.value > 0) v |= 0x02;
    if (this.triangle.length.value > 0) v |= 0x04;
    if (this.noise.length.value > 0) v |= 0x08;
    if (this.dmc.active()) v |= 0x10;
    if (this.frameIrqFlag) v |= 0x40;
    if (this.dmc.irqFlag) v |= 0x80;
    this.frameIrqFlag = false;
    return v;
  }

  private writeStatus(value: number): void {
    this.pulse1.length.setEnabled((value & 0x01) !== 0);
    this.pulse2.length.setEnabled((value & 0x02) !== 0);
    this.triangle.length.setEnabled((value & 0x04) !== 0);
    this.noise.length.setEnabled((value & 0x08) !== 0);
    this.dmc.setEnabled((value & 0x10) !== 0);
    this.dmc.irqFlag = false; // a $4015 write acknowledges the DMC interrupt
  }

  private writeFrameCounter(value: number): void {
    this.frameMode = (value >> 7) & 1;
    this.refreshFrameSeq();
    this.frameIrqInhibit = (value & 0x40) !== 0;
    if (this.frameIrqInhibit) this.frameIrqFlag = false;
    // Mode switch + (5-step) immediate quarter+half take effect now; only the
    // sequencer counter reset is delayed 3-4 CPU cycles (3 if the write lands on
    // an even/APU cycle, 4 if odd). `evenCycle` is already toggled for this cycle.
    if (this.frameMode === 1) {
      this.quarterFrame();
      this.halfFrame();
    }
    this.frameResetCountdown = this.evenCycle ? 3 : 4;
  }
}
