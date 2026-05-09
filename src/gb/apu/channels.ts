/**
 * APU channel implementations.
 *
 * All timers run in T-cycles (4 T-cycles per M-cycle).
 * Channels expose `sample()` returning 0–15, and are clocked by
 * the frame sequencer via `clockLength()`, `clockEnvelope()`, `clockSweep()`.
 *
 * Common plumbing (length counter, NRx4 trigger/length-enable quirks,
 * volume envelope) lives on two small abstract bases so the three
 * concrete channel classes only carry their per-waveform logic.
 */

// ─── Square duty patterns: bit N = step N (bit 0 → step 0) ──────────────────
// Duty 0 = 12.5% (1/8 high), 1 = 25%, 2 = 50%, 3 = 75%
import type { StateReader, StateWriter } from "../serialization/serialization.js";

const DUTY_TABLE = [0b00000001, 0b00000011, 0b00001111, 0b11111100] as const;

// ─── Abstract base — length counter + NRx4 trigger/length-enable quirks ─────
// Every channel has a length counter with identical decrement semantics, and
// every NRx4 write has the same "extra-clock on length-enable rising edge
// in an odd frame-sequencer step" quirk. Pulling it here eliminates three
// copies of clockLength() and three copies of the case-4 writeByte block.

abstract class ChannelBase {
  enabled = false;
  dacEnabled = false;

  /** NR*4: bit 7 = trigger, bit 6 = length-enable, bits 2-0 = freq-hi (Square/Wave). */
  protected nr4 = 0;

  protected lengthCounter = 0;

  /** Maximum (and reload-on-trigger) length — 64 for Square/Noise, 256 for Wave. */
  protected abstract readonly lengthMax: number;

  protected get lengthEnabled(): boolean {
    return (this.nr4 & 0x40) !== 0;
  }

  /** Clocked by the frame sequencer at 256 Hz (steps 0, 2, 4, 6). */
  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      if (--this.lengthCounter === 0) this.enabled = false;
    }
  }

  /** Subclass supplies the actual waveform-specific trigger work. */
  abstract trigger(apuOn: boolean): void;

  /**
   * Handle a write to NRx4. Drives the "extra length clock" quirk the
   * Blargg / Mooneye tests probe: if the new NRx4 enables length-counter
   * stepping *during the half of the frame sequencer where no length clock
   * would fire next*, the counter is clocked immediately.
   */
  protected writeNRx4(v: number, apuOn: boolean, fsStep: number): void {
    const oldLenEnabled = (this.nr4 & 0x40) !== 0;
    const newLenEnabled = (v & 0x40) !== 0;
    const triggering = (v & 0x80) !== 0;
    const extraClock = (fsStep & 1) === 1;
    this.nr4 = v;

    if (!oldLenEnabled && newLenEnabled && extraClock && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0 && !triggering) this.enabled = false;
    }
    if (triggering) {
      // Capture length *after* the enable-clock (above) so writes that
      // both enable and trigger with length=1 see the extra clock twice
      // (enable → 0, trigger reloads → max, extra → max-1).
      const lenBeforeTrigger = this.lengthCounter;
      this.trigger(apuOn);
      if (lenBeforeTrigger === 0 && newLenEnabled && extraClock && this.lengthCounter > 0) {
        this.lengthCounter--;
      }
    }
  }

  /** Reload length on trigger if it hit zero — all three channels share this. */
  protected reloadLengthOnTrigger(): void {
    if (this.lengthCounter === 0) this.lengthCounter = this.lengthMax;
  }
}

// ─── Abstract envelope-channel base (Square + Noise) ────────────────────────
// Volume envelope lives on NR*2 (bits 7-4 initial vol, bit 3 direction,
// bits 2-0 period). Identical clock behaviour in Square and Noise.

abstract class EnvelopeChannel extends ChannelBase {
  /** NR*2 — volume envelope register. */
  protected nr2 = 0;

  protected volume = 0;
  protected envTimer = 0;
  protected envRunning = false;

  protected get initVol(): number {
    return (this.nr2 >> 4) & 0x0f;
  }
  protected get envDir(): boolean {
    return (this.nr2 & 0x08) !== 0;
  }
  protected get envPeriod(): number {
    return this.nr2 & 0x07;
  }

  /** Frame-sequencer step 7 clocks the envelope at 64 Hz. */
  clockEnvelope(): void {
    if (!this.envRunning || this.envPeriod === 0) return;
    if (--this.envTimer <= 0) {
      this.envTimer = this.envPeriod;
      const nv = this.volume + (this.envDir ? 1 : -1);
      if (nv >= 0 && nv <= 15) this.volume = nv;
      else this.envRunning = false;
    }
  }

  /** Reload envelope state on channel trigger — shared by Square and Noise. */
  protected triggerEnvelope(): void {
    this.volume = this.initVol;
    this.envTimer = this.envPeriod;
    this.envRunning = this.envPeriod > 0;
  }

  /** NRx2 write: store the new byte and disable the channel if the DAC
   *  (upper 5 bits) is now zero. Used identically by Square and Noise. */
  protected writeNRx2(v: number): void {
    this.nr2 = v;
    this.dacEnabled = (v & 0xf8) !== 0;
    if (!this.dacEnabled) this.enabled = false;
  }
}

// ─── Square Channel (CH1: with sweep / CH2: without) ─────────────────────────

export class SquareChannel extends EnvelopeChannel {
  protected readonly lengthMax = 64;

  // NRx0 / NRx1 / NRx3 registers (NRx2 + NRx4 live on the bases).
  protected nr0 = 0; // sweep (CH1) / ignored (CH2)
  protected nr1 = 0; // duty + length load
  protected nr3 = 0; // freq lo

  // Frequency timer (T-cycles)
  private freqTimer = 0;
  private dutyPos = 0;

  // CH1 sweep
  private shadowFreq = 0;
  private sweepTimer = 0;
  private sweepEnabled = false;

  /** Set by `sweepCalc` when the calculation ran in negate mode. Cleared on
   *  trigger. If the game later exits negate mode via NR10 while this flag
   *  is set, the channel is immediately disabled — a documented hardware
   *  quirk exercised by Blargg cgb_sound test 05 ("Exiting negate mode"). */
  private sweepNegateUsed = false;

  constructor(readonly hasSweep: boolean) {
    super();
  }

  // ─── Register field helpers ───────────────────────────────────────────────

  get freqReg(): number {
    return ((this.nr4 & 0x07) << 8) | this.nr3;
  }
  set freqReg(v: number) {
    this.nr3 = v & 0xff;
    this.nr4 = (this.nr4 & 0xf8) | ((v >> 8) & 0x07);
  }
  private get duty(): number {
    return (this.nr1 >> 6) & 0x03;
  }

  private get sweepPeriod(): number {
    return (this.nr0 >> 4) & 0x07;
  }
  private get sweepNegate(): boolean {
    return (this.nr0 & 0x08) !== 0;
  }
  private get sweepShift(): number {
    return this.nr0 & 0x07;
  }

  // ─── Trigger ──────────────────────────────────────────────────────────────

  trigger(apuOn: boolean): void {
    this.enabled = apuOn && this.dacEnabled;
    this.reloadLengthOnTrigger();
    this.freqTimer = (2048 - this.freqReg) * 4;
    this.triggerEnvelope();

    if (this.hasSweep) {
      this.shadowFreq = this.freqReg;
      this.sweepTimer = this.sweepPeriod || 8;
      this.sweepEnabled = this.sweepPeriod > 0 || this.sweepShift > 0;
      this.sweepNegateUsed = false;
      if (this.sweepShift > 0) this.sweepCalc(); // immediate overflow check
    }
  }

  // ─── Per-T-cycle advance ──────────────────────────────────────────────────

  tick(tCycles: number): void {
    // Period is fixed for the duration of this call — a register write cannot
    // happen mid-tick, so caching avoids re-running the freqReg getter on
    // every loop iteration.
    const period = (2048 - this.freqReg) * 4;
    this.freqTimer -= tCycles;
    while (this.freqTimer <= 0) {
      this.freqTimer += period;
      this.dutyPos = (this.dutyPos + 1) & 7;
    }
  }

  clockSweep(): void {
    if (!this.hasSweep) return;
    if (--this.sweepTimer <= 0) {
      this.sweepTimer = this.sweepPeriod || 8;
      if (this.sweepEnabled && this.sweepPeriod > 0) {
        const nf = this.sweepCalc();
        if (nf <= 2047 && this.sweepShift > 0) {
          this.shadowFreq = nf;
          this.freqReg = nf;
          this.sweepCalc(); // second overflow check
        }
      }
    }
  }

  private sweepCalc(): number {
    const d = this.shadowFreq >> this.sweepShift;
    const nf = this.sweepNegate ? ((this.sweepNegateUsed = true), this.shadowFreq - d) : this.shadowFreq + d;
    if (nf > 2047) this.enabled = false;
    return nf;
  }

  // ─── Output ───────────────────────────────────────────────────────────────

  /** Returns 0–15. */
  sample(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    const pattern = DUTY_TABLE[this.duty]!;
    const bit = (pattern >> this.dutyPos) & 1;
    return bit * this.volume;
  }

  readByte(reg: number): number {
    switch (reg) {
      case 0:
        return this.hasSweep ? this.nr0 | 0x80 : 0xff;
      case 1:
        return this.nr1 | 0x3f; // only duty readable (length is write-only)
      case 2:
        return this.nr2;
      case 3:
        return 0xff; // freq lo: write-only
      case 4:
        return this.nr4 | 0xbf;
      default:
        return 0xff;
    }
  }

  writeByte(reg: number, v: number, apuOn: boolean, fsStep: number): void {
    switch (reg) {
      case 0: {
        if (!this.hasSweep) break;
        const oldNegate = (this.nr0 & 0x08) !== 0;
        const newNegate = (v & 0x08) !== 0;
        this.nr0 = v;
        // Exiting negate mode after at least one negate calculation has run
        // disables the channel immediately.
        if (oldNegate && !newNegate && this.sweepNegateUsed) this.enabled = false;
        break;
      }
      case 1:
        this.nr1 = v;
        this.lengthCounter = this.lengthMax - (v & 0x3f);
        break;
      case 2:
        this.writeNRx2(v);
        break;
      case 3:
        this.nr3 = v;
        break;
      case 4:
        this.writeNRx4(v, apuOn, fsStep);
        break;
    }
  }

  reset(): void {
    this.nr0 = this.nr1 = this.nr2 = this.nr3 = this.nr4 = 0;
    this.enabled = this.dacEnabled = false;
    this.freqTimer = this.dutyPos = this.lengthCounter = 0;
    this.volume = this.envTimer = 0;
    this.envRunning = false;
    this.shadowFreq = this.sweepTimer = 0;
    this.sweepEnabled = false;
    this.sweepNegateUsed = false;
  }

  serialize(w: StateWriter): void {
    w.bool(this.enabled);
    w.bool(this.dacEnabled);
    w.u8(this.nr0);
    w.u8(this.nr1);
    w.u8(this.nr2);
    w.u8(this.nr3);
    w.u8(this.nr4);
    w.i32(this.freqTimer);
    w.u8(this.dutyPos);
    w.u16(this.lengthCounter);
    w.u8(this.volume);
    w.i16(this.envTimer);
    w.bool(this.envRunning);
    w.u16(this.shadowFreq);
    w.i16(this.sweepTimer);
    w.bool(this.sweepEnabled);
  }
  deserialize(r: StateReader): void {
    this.enabled = r.bool();
    this.dacEnabled = r.bool();
    this.nr0 = r.u8();
    this.nr1 = r.u8();
    this.nr2 = r.u8();
    this.nr3 = r.u8();
    this.nr4 = r.u8();
    this.freqTimer = r.i32();
    this.dutyPos = r.u8();
    this.lengthCounter = r.u16();
    this.volume = r.u8();
    this.envTimer = r.i16();
    this.envRunning = r.bool();
    this.shadowFreq = r.u16();
    this.sweepTimer = r.i16();
    this.sweepEnabled = r.bool();
  }
}

// ─── Wave Channel (CH3) ───────────────────────────────────────────────────────

export class WaveChannel extends ChannelBase {
  protected readonly lengthMax = 256;

  readonly waveRam = new Uint8Array(16); // 32 4-bit samples

  private nr1 = 0; // length load
  private nr2 = 0; // output level
  private nr3 = 0; // freq lo

  // ── Wave-unit timing ───────────────────────────────────────────────
  // Real hardware's wave channel runs off a 2 MHz clock — the master
  // 4 MHz line divided by two — so its sample-advance events only ever
  // land on even master T-cycles. We model this with an explicit 2-T
  // prescaler so sub-M-cycle bus-access timing (see `CPU.busRead`)
  // resolves to the same phase hardware sees. Without it, the Blargg
  // `cgb_sound 09` 2-T-per-iteration sweep lands in the wrong
  // wavePos bucket and the CRC doesn't match.
  //
  // `freqTimer` is now in wave-unit ticks (half of master T-cycles);
  // `prescaler` accumulates master T-cycles until it reaches 2.
  private freqTimer = 0;
  private prescaler = 0;
  private wavePos = 0; // 0-31 position into wave RAM
  private waveBuffer = 0; // last fetched nibble (0-15)

  /** Byte index within `waveRam` that the channel is currently fetching
   *  from. CGB wave-RAM access intercept (reads/writes to $FF30-$FF3F
   *  while the channel is active) redirects to this index. */
  get currentByteIndex(): number {
    return this.wavePos >> 1;
  }

  private get freqReg(): number {
    return ((this.nr4 & 0x07) << 8) | this.nr3;
  }
  private get outputLevel(): number {
    return (this.nr2 >> 5) & 0x03;
  }

  trigger(apuOn: boolean): void {
    this.enabled = apuOn && this.dacEnabled;
    this.reloadLengthOnTrigger();
    this.freqTimer = 2048 - this.freqReg;
    this.prescaler = 0;
    this.wavePos = 0;
  }

  tick(tCycles: number): void {
    this.prescaler += tCycles;
    while (this.prescaler >= 2) {
      this.prescaler -= 2;
      if (--this.freqTimer <= 0) {
        this.freqTimer += 2048 - this.freqReg;
        this.wavePos = (this.wavePos + 1) & 31;
        const byte = this.waveRam[this.wavePos >> 1]!;
        this.waveBuffer = this.wavePos & 1 ? byte & 0x0f : byte >> 4;
      }
    }
  }

  /** Returns 0–15. Output is muted at level 0, shifted at 1/2/3. */
  sample(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    // level 0=mute, 1=100%, 2=50%, 3=25%
    const shift = [4, 0, 1, 2][this.outputLevel]!;
    return this.waveBuffer >> shift;
  }

  readByte(reg: number): number {
    switch (reg) {
      case 0:
        return this.dacEnabled ? 0xff : 0x7f; // bit 7 = DAC
      case 1:
        return 0xff; // length: write-only
      case 2:
        return this.nr2 | 0x9f; // only bits 6-5 readable
      case 3:
        return 0xff; // freq lo: write-only
      case 4:
        return this.nr4 | 0xbf;
      default:
        return 0xff;
    }
  }

  writeByte(reg: number, v: number, apuOn: boolean, fsStep: number): void {
    switch (reg) {
      case 0:
        this.dacEnabled = (v & 0x80) !== 0;
        if (!this.dacEnabled) this.enabled = false;
        break;
      case 1:
        this.nr1 = v;
        this.lengthCounter = this.lengthMax - v;
        break;
      case 2:
        this.nr2 = v;
        break;
      case 3:
        this.nr3 = v;
        break;
      case 4:
        this.writeNRx4(v, apuOn, fsStep);
        break;
    }
  }

  reset(): void {
    this.nr1 = this.nr2 = this.nr3 = this.nr4 = 0;
    this.enabled = this.dacEnabled = false;
    this.freqTimer = this.prescaler = this.wavePos = this.waveBuffer = this.lengthCounter = 0;
  }

  serialize(w: StateWriter): void {
    w.bool(this.enabled);
    w.bool(this.dacEnabled);
    w.u8(this.nr1);
    w.u8(this.nr2);
    w.u8(this.nr3);
    w.u8(this.nr4);
    w.i32(this.freqTimer);
    w.u8(this.wavePos);
    w.u8(this.waveBuffer);
    w.u16(this.lengthCounter);
    w.bytes(this.waveRam);
  }
  deserialize(r: StateReader): void {
    this.enabled = r.bool();
    this.dacEnabled = r.bool();
    this.nr1 = r.u8();
    this.nr2 = r.u8();
    this.nr3 = r.u8();
    this.nr4 = r.u8();
    this.freqTimer = r.i32();
    // Prescaler is deliberately not persisted: it's a sub-M-cycle
    // phase that converges to the correct value within microseconds of
    // resumed playback, so preserving it across saves isn't worth the
    // format-compat churn.
    this.prescaler = 0;
    this.wavePos = r.u8();
    this.waveBuffer = r.u8();
    this.lengthCounter = r.u16();
    r.bytes(this.waveRam);
  }
}

// ─── Noise Channel (CH4) ──────────────────────────────────────────────────────

// Noise clock divisors indexed by bits 2-0 of NR43
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112] as const;

export class NoiseChannel extends EnvelopeChannel {
  protected readonly lengthMax = 64;

  private nr1 = 0; // length load (bits 5-0)
  private nr3 = 0; // polynomial counter (clock shift + LFSR width + divisor)

  private freqTimer = 0;
  private lfsr = 0x7fff; // 15-bit LFSR, initialised to all 1s

  private get clockShift(): number {
    return (this.nr3 >> 4) & 0x0f;
  }
  private get lfsrWidth7(): boolean {
    return (this.nr3 & 0x08) !== 0;
  }
  private get divisorCode(): number {
    return this.nr3 & 0x07;
  }

  private get period(): number {
    return NOISE_DIVISORS[this.divisorCode]! << this.clockShift;
  }

  trigger(apuOn: boolean): void {
    this.enabled = apuOn && this.dacEnabled;
    this.reloadLengthOnTrigger();
    this.freqTimer = this.period;
    this.lfsr = 0x7fff;
    this.triggerEnvelope();
  }

  tick(tCycles: number): void {
    const period = this.period;
    const width7 = this.lfsrWidth7;
    this.freqTimer -= tCycles;
    while (this.freqTimer <= 0) {
      this.freqTimer += period;
      const xbit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr >>= 1;
      this.lfsr |= xbit << 14;
      if (width7) {
        this.lfsr &= ~(1 << 6);
        this.lfsr |= xbit << 6;
      }
    }
  }

  /** Returns 0–15 (bit 0 of LFSR inverted × volume). */
  sample(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    return (~this.lfsr & 1) * this.volume;
  }

  readByte(reg: number): number {
    switch (reg) {
      case 1:
        return 0xff; // length: write-only
      case 2:
        return this.nr2;
      case 3:
        return this.nr3;
      case 4:
        return this.nr4 | 0xbf;
      default:
        return 0xff;
    }
  }

  writeByte(reg: number, v: number, apuOn: boolean, fsStep: number): void {
    switch (reg) {
      case 1:
        this.nr1 = v;
        this.lengthCounter = this.lengthMax - (v & 0x3f);
        break;
      case 2:
        this.writeNRx2(v);
        break;
      case 3:
        this.nr3 = v;
        break;
      case 4:
        this.writeNRx4(v, apuOn, fsStep);
        break;
    }
  }

  reset(): void {
    this.nr1 = this.nr2 = this.nr3 = this.nr4 = 0;
    this.enabled = this.dacEnabled = false;
    this.freqTimer = this.lengthCounter = 0;
    this.lfsr = 0x7fff;
    this.volume = this.envTimer = 0;
    this.envRunning = false;
  }

  serialize(w: StateWriter): void {
    w.bool(this.enabled);
    w.bool(this.dacEnabled);
    w.u8(this.nr1);
    w.u8(this.nr2);
    w.u8(this.nr3);
    w.u8(this.nr4);
    w.i32(this.freqTimer);
    w.u16(this.lfsr);
    w.u16(this.lengthCounter);
    w.u8(this.volume);
    w.i16(this.envTimer);
    w.bool(this.envRunning);
  }
  deserialize(r: StateReader): void {
    this.enabled = r.bool();
    this.dacEnabled = r.bool();
    this.nr1 = r.u8();
    this.nr2 = r.u8();
    this.nr3 = r.u8();
    this.nr4 = r.u8();
    this.freqTimer = r.i32();
    this.lfsr = r.u16();
    this.lengthCounter = r.u16();
    this.volume = r.u8();
    this.envTimer = r.i16();
    this.envRunning = r.bool();
  }
}
