/**
 * PSG channel implementations for the GBA APU.
 *
 * GBA channels 1-4 are essentially the CGB APU's channels (square 1
 * with sweep, square 2, wave RAM, noise). The encoding lives in
 * SOUND[1-4]CNT_L/H/X — see `apu.ts` for the byte layout. This
 * module owns the audible state: duty position, envelope volume,
 * length counter, sweep shadow, LFSR. The owning `Apu` clocks the
 * frame sequencer (length / envelope / sweep) and the per-channel
 * timers (duty / wave-pos / LFSR).
 *
 * NRx4 trigger-edge quirks aren't modelled — they're the kind of
 * sub-cycle detail that test ROMs target but real games don't depend
 * on. If a future ROM cares, the equivalent code in src/gb/apu/
 * shows what the modelling looks like.
 */

import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";

/** Square duty mask table. Each entry is an 8-bit pattern; bit N
 *  (LSB-first) is the output at duty position N. */
const DUTY_TABLE = [0x80, 0x81, 0xe1, 0x7e] as const;

/** Common base for all PSG channels. Holds the on/off flag and the
 *  length counter (every channel has one with the same decrement
 *  semantics — only the reload value differs). */
abstract class ChannelBase {
  enabled = false;
  /** Length counter — counts down per frame-sequencer length clock,
   *  disables the channel on reaching zero (if length-enable is set). */
  lengthCounter = 0;
  /** Length-enable bit (NRx4 / cntX bit 14). */
  lengthEnabled = false;
  /** Maximum length value to reload on trigger. */
  protected abstract readonly lengthMax: number;

  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      if (--this.lengthCounter === 0) this.enabled = false;
    }
  }

  protected reloadLengthOnTrigger(): void {
    if (this.lengthCounter === 0) this.lengthCounter = this.lengthMax;
  }
}

/** Square-wave channel — used by both PSG channel 1 (with sweep) and
 *  channel 2 (without). Frequency is the 11-bit value read from the
 *  channel's frequency register; period in CPU cycles is
 *  `(2048 - freq) * 16` per duty step (8 steps make one full wave). */
export class SquareChannel extends ChannelBase {
  protected readonly lengthMax = 64;

  duty = 0; // 0-3, selects DUTY_TABLE entry
  dutyPosition = 0; // 0-7, current step in the 8-step cycle
  private dutyTimer = 0;
  /** 11-bit frequency value as read from the channel's frequency
   *  register. Sweep mutates this in place on ch1; ch2 leaves it
   *  alone. */
  frequency = 0;

  /** Envelope state (NRx2-style). */
  volume = 0;
  private envInitVol = 0;
  private envDirectionUp = false;
  private envPeriod = 0;
  private envTimer = 0;
  private envRunning = false;
  /** DAC is enabled when bits 3-7 of the envelope nibble are non-zero
   *  (init vol > 0 or env direction set). Mirrors the GB rule. */
  dacEnabled = false;

  /** Sweep state — channel 1 only. cntL on ch1 holds the sweep
   *  config; ch2 ignores it. */
  private sweepEnabled = false;
  private sweepShift = 0;
  private sweepDirectionDown = false;
  private sweepPeriod = 0;
  private sweepTimer = 0;
  private sweepShadowFreq = 0;
  private sweepHasShift = false;

  /** Reconfigure the envelope+duty fields. For channel 1 this is
   *  `cntH` (duty + length + envelope at bits 0-15); for channel 2
   *  it's `cntL` (same layout, different address). */
  setEnvelopeAndDuty(value: number): void {
    const lengthSpec = value & 0x3f;
    this.lengthCounter = this.lengthMax - lengthSpec;
    this.duty = (value >>> 6) & 0x3;
    this.envPeriod = (value >>> 8) & 0x7;
    this.envDirectionUp = (value & (1 << 11)) !== 0;
    this.envInitVol = (value >>> 12) & 0xf;
    this.dacEnabled = (value & 0xf800) !== 0;
    if (!this.dacEnabled) this.enabled = false;
  }

  /** Apply a write to the channel's frequency / control register
   *  (cntX on ch1, cntH on ch2). Returns true if the write triggered
   *  the channel. */
  setFrequencyControl(value: number): boolean {
    this.frequency = value & 0x07ff;
    this.lengthEnabled = (value & (1 << 14)) !== 0;
    const triggering = (value & (1 << 15)) !== 0;
    if (triggering) this.trigger();
    return triggering;
  }

  /** Apply a write to channel 1's sweep register (cntL). Channel 2
   *  should never call this. */
  setSweep(value: number): void {
    this.sweepShift = value & 0x7;
    this.sweepDirectionDown = (value & (1 << 3)) !== 0;
    this.sweepPeriod = (value >>> 4) & 0x7;
  }

  /** Channel trigger — reload internal state and re-enable. */
  trigger(): void {
    if (this.dacEnabled) this.enabled = true;
    this.reloadLengthOnTrigger();
    this.dutyTimer = (2048 - this.frequency) * 16;
    // Envelope reload
    this.volume = this.envInitVol;
    this.envTimer = this.envPeriod === 0 ? 8 : this.envPeriod;
    this.envRunning = true;
    // Sweep reload (ch1 only — ch2 leaves sweepPeriod=0)
    this.sweepShadowFreq = this.frequency;
    this.sweepHasShift = this.sweepShift !== 0;
    this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepHasShift;
    this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
    if (this.sweepHasShift) {
      // The initial overflow check on trigger can disable the channel.
      this.sweepCalcAndOverflow(false);
    }
  }

  /** Advance the duty timer by `cycles` CPU cycles. Each timer
   *  underflow advances the duty position by 1. */
  tickDuty(cycles: number): void {
    if (!this.enabled) return;
    let remaining = cycles | 0;
    while (remaining > 0) {
      if (this.dutyTimer > remaining) {
        this.dutyTimer -= remaining;
        return;
      }
      remaining -= this.dutyTimer;
      this.dutyPosition = (this.dutyPosition + 1) & 7;
      this.dutyTimer = (2048 - this.frequency) * 16;
      if (this.dutyTimer <= 0) this.dutyTimer = 16; // guard against freq=2048 (silent)
    }
  }

  /** Frame-sequencer envelope clock — fired at step 7 (64 Hz). */
  clockEnvelope(): void {
    if (!this.envRunning || this.envPeriod === 0) return;
    if (--this.envTimer <= 0) {
      this.envTimer = this.envPeriod;
      const next = this.volume + (this.envDirectionUp ? 1 : -1);
      if (next >= 0 && next <= 15) this.volume = next;
      else this.envRunning = false;
    }
  }

  /** Frame-sequencer sweep clock — fired at steps 2 and 6 (128 Hz). */
  clockSweep(): void {
    if (!this.sweepEnabled) return;
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
    if (this.sweepPeriod === 0) return;
    if (this.sweepHasShift) this.sweepCalcAndOverflow(true);
  }

  /** Compute the next sweep frequency, run the overflow check, and
   *  (when called from a sweep tick, `commit=true`) write it back to
   *  the live frequency. Disables the channel on overflow. */
  private sweepCalcAndOverflow(commit: boolean): void {
    const delta = this.sweepShadowFreq >>> this.sweepShift;
    const next = this.sweepDirectionDown ? this.sweepShadowFreq - delta : this.sweepShadowFreq + delta;
    if (next > 2047) {
      this.enabled = false;
      this.sweepEnabled = false;
      return;
    }
    if (commit && this.sweepShift !== 0) {
      this.sweepShadowFreq = next;
      this.frequency = next;
      // Second overflow check immediately afterwards (GB hardware).
      const delta2 = this.sweepShadowFreq >>> this.sweepShift;
      const next2 = this.sweepDirectionDown ? this.sweepShadowFreq - delta2 : this.sweepShadowFreq + delta2;
      if (next2 > 2047) {
        this.enabled = false;
        this.sweepEnabled = false;
      }
    }
  }

  /** Current sample as a signed amplitude in [-volume, +volume]. The
   *  caller scales further by the mixer's master volume. Returns 0
   *  when the channel is disabled. */
  sample(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    const high = (DUTY_TABLE[this.duty]! >>> this.dutyPosition) & 1;
    // Two-level (high/low) signed amplitude — high → +volume, low → -volume.
    return high ? this.volume : -this.volume;
  }

  serialize(w: GbaStateWriter): void {
    w.bool(this.enabled);
    w.u16(this.lengthCounter);
    w.bool(this.lengthEnabled);
    w.u8(this.duty);
    w.u8(this.dutyPosition);
    w.i32(this.dutyTimer);
    w.u16(this.frequency);
    w.u8(this.volume);
    w.u8(this.envInitVol);
    w.bool(this.envDirectionUp);
    w.u8(this.envPeriod);
    w.i32(this.envTimer);
    w.bool(this.envRunning);
    w.bool(this.dacEnabled);
    w.bool(this.sweepEnabled);
    w.u8(this.sweepShift);
    w.bool(this.sweepDirectionDown);
    w.u8(this.sweepPeriod);
    w.i32(this.sweepTimer);
    w.u16(this.sweepShadowFreq);
    w.bool(this.sweepHasShift);
  }

  deserialize(r: GbaStateReader): void {
    this.enabled = r.bool();
    this.lengthCounter = r.u16();
    this.lengthEnabled = r.bool();
    this.duty = r.u8();
    this.dutyPosition = r.u8();
    this.dutyTimer = r.i32();
    this.frequency = r.u16();
    this.volume = r.u8();
    this.envInitVol = r.u8();
    this.envDirectionUp = r.bool();
    this.envPeriod = r.u8();
    this.envTimer = r.i32();
    this.envRunning = r.bool();
    this.dacEnabled = r.bool();
    this.sweepEnabled = r.bool();
    this.sweepShift = r.u8();
    this.sweepDirectionDown = r.bool();
    this.sweepPeriod = r.u8();
    this.sweepTimer = r.i32();
    this.sweepShadowFreq = r.u16();
    this.sweepHasShift = r.bool();
  }
}

/** PSG channel 3 — 32-sample-per-cycle wave RAM playback.
 *
 *  Wave RAM is 16 bytes total = 32 nibbles = one bank of 32 samples
 *  (or 64 samples across two banks when SOUND3CNT_L bit 5 is set).
 *  Each nibble is a 4-bit unsigned sample in [0, 15] which we
 *  recentred to [-7.5, 7.5] for mixer-friendly signed amplitudes
 *  (rounded to integer by scaling × 2 and centring around 0).
 *
 *  Sample period: `(2048 - freq) * 8` CPU cycles at 16.78 MHz. Volume
 *  shifts: 0 mutes, 1 = 100%, 2 = 50%, 3 = 25%, force-75% bit
 *  overrides. */
export class WaveChannel extends ChannelBase {
  protected readonly lengthMax = 256;

  /** Live wave-RAM samples that the channel sees. Owned by the Apu
   *  but referenced here for sampling. */
  private waveRam: Uint8Array = new Uint8Array(16);

  /** Current sample index — 0..31 in single-bank mode, 0..63 in
   *  double-bank mode. */
  position = 0;
  private positionTimer = 0;
  private frequency = 0;
  private volumeShift = 4; // 4 = mute (bit-shift on samples 0-15)
  private forceFullVolume = false;
  private doubleBank = false;
  private currentBank = 0;
  /** SOUND3CNT_L bit 7 — channel/DAC enable. */
  dacEnabled = false;

  attachWaveRam(ram: Uint8Array): void {
    this.waveRam = ram;
  }

  /** Apply a write to SOUND3CNT_L. */
  setControl(value: number): void {
    this.doubleBank = (value & (1 << 5)) !== 0;
    this.currentBank = (value >>> 6) & 1;
    this.dacEnabled = (value & (1 << 7)) !== 0;
    if (!this.dacEnabled) this.enabled = false;
  }

  /** Apply a write to SOUND3CNT_H. */
  setLengthAndVolume(value: number): void {
    this.lengthCounter = this.lengthMax - (value & 0xff);
    const volBits = (value >>> 13) & 0x3;
    this.volumeShift = volBits === 0 ? 4 /* mute via huge shift */ : volBits - 1;
    this.forceFullVolume = (value & (1 << 15)) !== 0;
  }

  /** Apply a write to SOUND3CNT_X. Returns true if the trigger bit
   *  was set in `value`. */
  setFrequencyControl(value: number): boolean {
    this.frequency = value & 0x07ff;
    this.lengthEnabled = (value & (1 << 14)) !== 0;
    const triggering = (value & (1 << 15)) !== 0;
    if (triggering) this.trigger();
    return triggering;
  }

  trigger(): void {
    if (this.dacEnabled) this.enabled = true;
    this.reloadLengthOnTrigger();
    this.position = 0;
    this.positionTimer = (2048 - this.frequency) * 8;
  }

  tickWave(cycles: number): void {
    if (!this.enabled) return;
    let remaining = cycles | 0;
    while (remaining > 0) {
      if (this.positionTimer > remaining) {
        this.positionTimer -= remaining;
        return;
      }
      remaining -= this.positionTimer;
      const positionMod = this.doubleBank ? 64 : 32;
      this.position = (this.position + 1) % positionMod;
      this.positionTimer = (2048 - this.frequency) * 8;
      if (this.positionTimer <= 0) this.positionTimer = 8;
    }
  }

  /** Current sample in approximately [-15, +15] (4-bit unsigned recentred
   *  and volume-shifted). Returns 0 when disabled. */
  sample(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    // In single-bank mode the active bank (SOUND3CNT_L bit 6) provides
    // all 32 samples; the other 8 bytes are visible to the bus only.
    // In double-bank mode samples 0-31 read from the first bank and
    // 32-63 from the second, but the *starting* bank flips between
    // triggers via the currentBank bit. We follow GBATEK's bank-select
    // rule: position selects within the active 32-sample run.
    let pos = this.position;
    let bankBaseByte = this.currentBank === 0 ? 0 : 8;
    if (this.doubleBank && pos >= 32) {
      pos -= 32;
      bankBaseByte = this.currentBank === 0 ? 8 : 0;
    }
    const byte = this.waveRam[bankBaseByte + (pos >>> 1)] ?? 0;
    const nibble = (pos & 1) === 0 ? (byte >>> 4) & 0xf : byte & 0xf;
    const centred = nibble * 2 - 15; // map 0..15 to -15..+15
    if (this.forceFullVolume) {
      // 75% volume — multiply by 3/4. The samples are already in
      // -15..15 so 3/4 * sample ≈ -11..+11.
      return (centred * 3) >> 2;
    }
    // volumeShift: 0 = full (>>0), 1 = half (>>1), 2 = quarter (>>2),
    // 4 = mute (>>4 → 0 for any value in our range).
    return centred >> this.volumeShift;
  }

  serialize(w: GbaStateWriter): void {
    w.bool(this.enabled);
    w.u16(this.lengthCounter);
    w.bool(this.lengthEnabled);
    w.u8(this.position);
    w.i32(this.positionTimer);
    w.u16(this.frequency);
    w.u8(this.volumeShift);
    w.bool(this.forceFullVolume);
    w.bool(this.doubleBank);
    w.u8(this.currentBank);
    w.bool(this.dacEnabled);
  }

  deserialize(r: GbaStateReader): void {
    this.enabled = r.bool();
    this.lengthCounter = r.u16();
    this.lengthEnabled = r.bool();
    this.position = r.u8();
    this.positionTimer = r.i32();
    this.frequency = r.u16();
    this.volumeShift = r.u8();
    this.forceFullVolume = r.bool();
    this.doubleBank = r.bool();
    this.currentBank = r.u8();
    this.dacEnabled = r.bool();
  }
}

/** PSG channel 4 — noise via LFSR.
 *
 *  Linear-feedback shift register with selectable 15-bit or 7-bit
 *  width. Each period: `bit_new = bit0 XOR bit1`; LFSR shifts right
 *  by 1 and bit_new becomes the new bit 14 (15-bit mode) or both
 *  bit 14 and bit 6 (7-bit mode, narrowing the cycle to 127 states).
 *  Output level = `bit0 ? -volume : +volume` — same two-level signed
 *  amplitude as the square channels.
 *
 *  Period formula (GBA CPU cycles, 16.78 MHz):
 *    divisor = ratio == 0 ? 8 : ratio * 16
 *    period  = (divisor << shiftClockFreq) * 4
 *
 *  The `* 4` lifts the CGB formula (which is expressed in 4.19 MHz
 *  T-cycles) to GBA cycles — same reason `SquareChannel` uses ×16
 *  and `WaveChannel` uses ×8 where the CGB values are ×4 and ×2.
 *  Without it the LFSR runs four times too fast, pitching channel
 *  4 up by two octaves.
 *
 *  Envelope + length share semantics with SquareChannel. */
export class NoiseChannel extends ChannelBase {
  protected readonly lengthMax = 64;

  /** LFSR state — 15 bits used in normal mode, 7 bits in narrow mode. */
  private lfsr = 0x7fff;
  private narrowMode = false;
  private periodTimer = 0;
  private periodCycles = 8;

  /** Envelope (same shape as SquareChannel's). */
  volume = 0;
  private envInitVol = 0;
  private envDirectionUp = false;
  private envPeriod = 0;
  private envTimer = 0;
  private envRunning = false;
  dacEnabled = false;

  setEnvelope(value: number): void {
    const lengthSpec = value & 0x3f;
    this.lengthCounter = this.lengthMax - lengthSpec;
    this.envPeriod = (value >>> 8) & 0x7;
    this.envDirectionUp = (value & (1 << 11)) !== 0;
    this.envInitVol = (value >>> 12) & 0xf;
    this.dacEnabled = (value & 0xf800) !== 0;
    if (!this.dacEnabled) this.enabled = false;
  }

  setFrequencyControl(value: number): boolean {
    const ratio = value & 0x7;
    const divisor = ratio === 0 ? 8 : ratio * 16;
    const shift = (value >>> 4) & 0xf;
    this.periodCycles = (divisor << shift) * 4;
    if (this.periodCycles <= 0) this.periodCycles = 32;
    this.narrowMode = (value & (1 << 3)) !== 0;
    this.lengthEnabled = (value & (1 << 14)) !== 0;
    const triggering = (value & (1 << 15)) !== 0;
    if (triggering) this.trigger();
    return triggering;
  }

  trigger(): void {
    if (this.dacEnabled) this.enabled = true;
    this.reloadLengthOnTrigger();
    this.lfsr = 0x7fff;
    this.periodTimer = this.periodCycles;
    this.volume = this.envInitVol;
    this.envTimer = this.envPeriod === 0 ? 8 : this.envPeriod;
    this.envRunning = true;
  }

  tickLfsr(cycles: number): void {
    if (!this.enabled) return;
    let remaining = cycles | 0;
    while (remaining > 0) {
      if (this.periodTimer > remaining) {
        this.periodTimer -= remaining;
        return;
      }
      remaining -= this.periodTimer;
      this.periodTimer = this.periodCycles;
      // Tap bits 0 and 1, XOR, push back into the top.
      const bitNew = (this.lfsr & 1) ^ ((this.lfsr >>> 1) & 1);
      this.lfsr >>>= 1;
      this.lfsr |= bitNew << 14;
      if (this.narrowMode) {
        // 7-bit mode mirrors bit_new into bit 6, so the LFSR cycle
        // narrows to 127 states.
        this.lfsr = (this.lfsr & ~0x40) | (bitNew << 6);
      }
    }
  }

  clockEnvelope(): void {
    if (!this.envRunning || this.envPeriod === 0) return;
    if (--this.envTimer <= 0) {
      this.envTimer = this.envPeriod;
      const next = this.volume + (this.envDirectionUp ? 1 : -1);
      if (next >= 0 && next <= 15) this.volume = next;
      else this.envRunning = false;
    }
  }

  sample(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    // Output is HIGH (positive) when bit 0 of the LFSR is 0, LOW (negative)
    // when it's 1.
    return (this.lfsr & 1) === 0 ? this.volume : -this.volume;
  }

  serialize(w: GbaStateWriter): void {
    w.bool(this.enabled);
    w.u16(this.lengthCounter);
    w.bool(this.lengthEnabled);
    w.u16(this.lfsr);
    w.bool(this.narrowMode);
    w.i32(this.periodTimer);
    w.i32(this.periodCycles);
    w.u8(this.volume);
    w.u8(this.envInitVol);
    w.bool(this.envDirectionUp);
    w.u8(this.envPeriod);
    w.i32(this.envTimer);
    w.bool(this.envRunning);
    w.bool(this.dacEnabled);
  }

  deserialize(r: GbaStateReader): void {
    this.enabled = r.bool();
    this.lengthCounter = r.u16();
    this.lengthEnabled = r.bool();
    this.lfsr = r.u16();
    this.narrowMode = r.bool();
    this.periodTimer = r.i32();
    this.periodCycles = r.i32();
    this.volume = r.u8();
    this.envInitVol = r.u8();
    this.envDirectionUp = r.bool();
    this.envPeriod = r.u8();
    this.envTimer = r.i32();
    this.envRunning = r.bool();
    this.dacEnabled = r.bool();
  }
}
