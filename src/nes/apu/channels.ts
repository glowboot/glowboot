/**
 * 2A03 sound channels: 2 pulse (square), triangle, noise, and DMC, plus the
 * shared length-counter and envelope units. Ported from the NESdev reference
 * (https://www.nesdev.org/wiki/APU_Pulse, /APU_Triangle, /APU_Noise, /APU_DMC).
 *
 * Each channel exposes write() for its $40xx registers, the per-clock timer
 * tick(s), the frame-sequencer clocks (quarter = envelope/linear, half =
 * length/sweep), and output() returning its current level (0-15 for the tone
 * channels, 0-127 for the DMC).
 */

import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";

// Length-counter load values, indexed by the top 5 bits of the length register.
// prettier-ignore
export const LENGTH_TABLE: readonly number[] = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
];

// prettier-ignore
const DUTY: readonly (readonly number[])[] = [
  [0, 1, 0, 0, 0, 0, 0, 0], // 12.5%
  [0, 1, 1, 0, 0, 0, 0, 0], // 25%
  [0, 1, 1, 1, 1, 0, 0, 0], // 50%
  [1, 0, 0, 1, 1, 1, 1, 1]  // 25% negated
];

// prettier-ignore
const TRIANGLE_SEQ: readonly number[] = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
];

// NTSC noise timer periods (CPU cycles), indexed by $400E low nibble.
// prettier-ignore
const NOISE_PERIOD: readonly number[] = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068
];

// NTSC DMC rate table (CPU cycles per output clock), indexed by $4010 low nibble.
// prettier-ignore
const DMC_RATE: readonly number[] = [
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54
];

/** Length counter — gates a channel and counts down on half-frame clocks.
 *
 * Halt-flag and length-reload writes don't take effect until *after* the length
 * is next clocked: the frame sequencer clocks the length before the CPU's write
 * to the same register lands. So writes are staged and applied by {@link
 * endCycle}, which the APU calls each CPU cycle right after the sequencer clock.
 * A reload that coincides with a clock is dropped if the counter was actually
 * decremented, but still loads if it was already zero. */
class LengthCounter {
  enabled = false;
  halt = false;
  value = 0;
  private haltWrite = -1; // staged halt (0/1), -1 when none
  private reloadWrite = -1; // staged $400x+3 high byte, -1 when none
  private decremented = false; // did this cycle's clock actually count down?

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.value = 0;
  }
  writeHalt(on: boolean): void {
    this.haltWrite = on ? 1 : 0;
  }
  writeReload(regHigh: number): void {
    this.reloadWrite = regHigh;
  }
  clock(): void {
    if (!this.halt && this.value > 0) {
      this.value--;
      this.decremented = true;
    }
  }
  /** Apply staged halt/reload writes — call once per CPU cycle, after the frame
   *  sequencer's possible length clock. */
  endCycle(): void {
    if (this.haltWrite >= 0) {
      this.halt = this.haltWrite === 1;
      this.haltWrite = -1;
    }
    if (this.reloadWrite >= 0) {
      if (this.enabled && !this.decremented) this.value = LENGTH_TABLE[this.reloadWrite >> 3]!;
      this.reloadWrite = -1;
    }
    this.decremented = false;
  }

  serialize(w: NesStateWriter): void {
    w.bool(this.enabled);
    w.bool(this.halt);
    w.u8(this.value);
  }
  deserialize(r: NesStateReader): void {
    this.enabled = r.bool();
    this.halt = r.bool();
    this.value = r.u8();
  }
}

/** Volume envelope shared by the pulse and noise channels. */
class Envelope {
  start = false;
  loop = false;
  constant = false;
  volume = 0; // also the divider period
  private divider = 0;
  private decay = 0;

  clock(): void {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
    } else if (this.divider === 0) {
      this.divider = this.volume;
      if (this.decay > 0) this.decay--;
      else if (this.loop) this.decay = 15;
    } else {
      this.divider--;
    }
  }
  output(): number {
    return this.constant ? this.volume : this.decay;
  }

  serialize(w: NesStateWriter): void {
    w.bool(this.start);
    w.bool(this.loop);
    w.bool(this.constant);
    w.u8(this.volume);
    w.u8(this.divider);
    w.u8(this.decay);
  }
  deserialize(r: NesStateReader): void {
    this.start = r.bool();
    this.loop = r.bool();
    this.constant = r.bool();
    this.volume = r.u8();
    this.divider = r.u8();
    this.decay = r.u8();
  }
}

export class PulseChannel {
  readonly length = new LengthCounter();
  private readonly env = new Envelope();
  private duty = 0;
  private dutyStep = 0;
  private timerPeriod = 0;
  private timer = 0;
  // Sweep unit.
  private sweepEnabled = false;
  private sweepPeriod = 0;
  private sweepNegate = false;
  private sweepShift = 0;
  private sweepReload = false;
  private sweepDivider = 0;

  /** Channel 1's sweep uses one's-complement negate, channel 2 two's. */
  constructor(private readonly onesComplement: boolean) {}

  write(reg: number, value: number): void {
    switch (reg & 3) {
      case 0:
        this.duty = value >> 6;
        this.length.writeHalt((value & 0x20) !== 0);
        this.env.loop = (value & 0x20) !== 0;
        this.env.constant = (value & 0x10) !== 0;
        this.env.volume = value & 0x0f;
        break;
      case 1:
        this.sweepEnabled = (value & 0x80) !== 0;
        this.sweepPeriod = (value >> 4) & 7;
        this.sweepNegate = (value & 0x08) !== 0;
        this.sweepShift = value & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | value;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((value & 7) << 8);
        this.length.writeReload(value);
        this.dutyStep = 0;
        this.env.start = true;
        break;
    }
  }

  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      this.dutyStep = (this.dutyStep + 1) & 7;
    } else {
      this.timer--;
    }
  }
  clockEnvelope(): void {
    this.env.clock();
  }
  clockLengthAndSweep(): void {
    this.length.clock();
    this.clockSweep();
  }

  private targetPeriod(): number {
    let change = this.timerPeriod >> this.sweepShift;
    if (this.sweepNegate) change = this.onesComplement ? -change - 1 : -change;
    return this.timerPeriod + change;
  }
  private clockSweep(): void {
    const target = this.targetPeriod();
    if (
      this.sweepDivider === 0 &&
      this.sweepEnabled &&
      this.sweepShift > 0 &&
      target <= 0x7ff &&
      this.timerPeriod >= 8
    ) {
      this.timerPeriod = target;
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }

  output(): number {
    if (this.length.value === 0) return 0;
    if (DUTY[this.duty]![this.dutyStep] === 0) return 0;
    if (this.timerPeriod < 8 || this.targetPeriod() > 0x7ff) return 0; // swept out of range
    return this.env.output();
  }

  serialize(w: NesStateWriter): void {
    this.length.serialize(w);
    this.env.serialize(w);
    w.u8(this.duty);
    w.u8(this.dutyStep);
    w.u16(this.timerPeriod);
    w.u16(this.timer);
    w.bool(this.sweepEnabled);
    w.u8(this.sweepPeriod);
    w.bool(this.sweepNegate);
    w.u8(this.sweepShift);
    w.bool(this.sweepReload);
    w.u8(this.sweepDivider);
  }
  deserialize(r: NesStateReader): void {
    this.length.deserialize(r);
    this.env.deserialize(r);
    this.duty = r.u8();
    this.dutyStep = r.u8();
    this.timerPeriod = r.u16();
    this.timer = r.u16();
    this.sweepEnabled = r.bool();
    this.sweepPeriod = r.u8();
    this.sweepNegate = r.bool();
    this.sweepShift = r.u8();
    this.sweepReload = r.bool();
    this.sweepDivider = r.u8();
  }
}

export class TriangleChannel {
  readonly length = new LengthCounter();
  private timerPeriod = 0;
  private timer = 0;
  private step = 0;
  private linearReload = 0;
  private linearCounter = 0;
  private linearReloadFlag = false;
  private control = false; // also the length halt flag

  write(reg: number, value: number): void {
    switch (reg & 3) {
      case 0:
        this.control = (value & 0x80) !== 0;
        this.length.writeHalt((value & 0x80) !== 0);
        this.linearReload = value & 0x7f;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | value;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((value & 7) << 8);
        this.length.writeReload(value);
        this.linearReloadFlag = true;
        break;
    }
  }

  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      if (this.length.value > 0 && this.linearCounter > 0) this.step = (this.step + 1) & 31;
    } else {
      this.timer--;
    }
  }
  clockLinear(): void {
    if (this.linearReloadFlag) this.linearCounter = this.linearReload;
    else if (this.linearCounter > 0) this.linearCounter--;
    if (!this.control) this.linearReloadFlag = false;
  }
  clockLength(): void {
    this.length.clock();
  }

  output(): number {
    // The sequencer holds when silenced; very high frequencies are muted to
    // avoid a popping DC tone.
    if (this.timerPeriod < 2) return 7;
    return TRIANGLE_SEQ[this.step]!;
  }

  serialize(w: NesStateWriter): void {
    this.length.serialize(w);
    w.u16(this.timerPeriod);
    w.u16(this.timer);
    w.u8(this.step);
    w.u8(this.linearReload);
    w.u8(this.linearCounter);
    w.bool(this.linearReloadFlag);
    w.bool(this.control);
  }
  deserialize(r: NesStateReader): void {
    this.length.deserialize(r);
    this.timerPeriod = r.u16();
    this.timer = r.u16();
    this.step = r.u8();
    this.linearReload = r.u8();
    this.linearCounter = r.u8();
    this.linearReloadFlag = r.bool();
    this.control = r.bool();
  }
}

export class NoiseChannel {
  readonly length = new LengthCounter();
  private readonly env = new Envelope();
  private timerPeriod = 0;
  private timer = 0;
  private shift = 1;
  private mode = false;
  /** NTSC by default; the APU swaps in the PAL table on a region change. */
  private periods: readonly number[] = NOISE_PERIOD;

  /** Select the NTSC / PAL noise-period table. The active `timerPeriod`
   *  refreshes from the new table on the next $400E write. */
  setPeriods(periods: readonly number[]): void {
    this.periods = periods;
  }

  write(reg: number, value: number): void {
    switch (reg & 3) {
      case 0:
        this.length.writeHalt((value & 0x20) !== 0);
        this.env.loop = (value & 0x20) !== 0;
        this.env.constant = (value & 0x10) !== 0;
        this.env.volume = value & 0x0f;
        break;
      case 2:
        this.mode = (value & 0x80) !== 0;
        this.timerPeriod = this.periods[value & 0x0f]!;
        break;
      case 3:
        this.length.writeReload(value);
        this.env.start = true;
        break;
    }
  }

  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      const fb = (this.shift & 1) ^ ((this.shift >> (this.mode ? 6 : 1)) & 1);
      this.shift = (this.shift >> 1) | (fb << 14);
    } else {
      this.timer--;
    }
  }
  clockEnvelope(): void {
    this.env.clock();
  }
  clockLength(): void {
    this.length.clock();
  }

  output(): number {
    if (this.length.value === 0 || (this.shift & 1) !== 0) return 0;
    return this.env.output();
  }

  serialize(w: NesStateWriter): void {
    this.length.serialize(w);
    this.env.serialize(w);
    w.u16(this.timerPeriod);
    w.u16(this.timer);
    w.u16(this.shift);
    w.bool(this.mode);
  }
  deserialize(r: NesStateReader): void {
    this.length.deserialize(r);
    this.env.deserialize(r);
    this.timerPeriod = r.u16();
    this.timer = r.u16();
    this.shift = r.u16();
    this.mode = r.bool();
  }
}

export class DmcChannel {
  enabled = false;
  irqFlag = false;
  private irqEnabled = false;
  private loop = false;
  private rates: readonly number[] = DMC_RATE;
  private rate = DMC_RATE[0]!;
  private timer = 0;
  private level = 0; // 7-bit output
  private startAddr = 0xc000;
  private startLen = 1;
  private currentAddr = 0xc000;
  private bytesRemaining = 0;
  private sampleBuffer = 0;
  private sampleBufferEmpty = true;
  private shiftReg = 0;
  private bitsRemaining = 8;
  private silence = true;
  /** A sample fetch is waiting for the CPU to be halted (RDY low). Raised the
   *  cycle the buffer runs empty; cleared when {@link dmaFetch} delivers. */
  private dmaRequested = false;
  /** Whether the pending request is a reload DMA — see {@link onDmaRequest}. */
  private dmaReload = false;
  /** Fires while a DMA request is unserviced — the console routes it to the
   *  CPU, whose next read cycle performs the stall. `reload` is true for
   *  buffer-emptied-by-the-output-unit DMAs, which are synchronized to the
   *  DMC timer's fixed APU phase and always steal 4 cycles; $4015 "load" DMAs
   *  vary with alignment. */
  onDmaRequest: ((reload: boolean) => void) | null = null;

  private raiseDma(reload: boolean): void {
    if (!this.dmaRequested) {
      this.dmaRequested = true;
      this.dmaReload = reload; // the kind is fixed at the rising edge
    }
    this.onDmaRequest?.(this.dmaReload);
  }

  /** `read` fetches a sample byte from CPU space ($8000-$FFFF). */
  constructor(private readonly read: (addr: number) => number) {}

  /** Select the NTSC / PAL DMC rate table. The active `rate` refreshes from
   *  the new table on the next $4010 write. */
  setRates(rates: readonly number[]): void {
    this.rates = rates;
  }

  write(reg: number, value: number): void {
    switch (reg & 3) {
      case 0:
        this.irqEnabled = (value & 0x80) !== 0;
        if (!this.irqEnabled) this.irqFlag = false;
        this.loop = (value & 0x40) !== 0;
        this.rate = this.rates[value & 0x0f]!;
        break;
      case 1:
        this.level = value & 0x7f;
        break;
      case 2:
        this.startAddr = 0xc000 | (value << 6);
        break;
      case 3:
        this.startLen = (value << 4) | 1;
        break;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.irqFlag = false;
    if (!on) {
      this.bytesRemaining = 0;
    } else if (this.bytesRemaining === 0) {
      this.currentAddr = this.startAddr;
      this.bytesRemaining = this.startLen;
      // Enabling over an empty buffer starts a "load" DMA.
      if (this.sampleBufferEmpty) this.raiseDma(false);
    }
  }
  active(): boolean {
    return this.bytesRemaining > 0;
  }

  clockTimer(): void {
    // Safety net for exotic transitions (e.g. a restored save state carrying
    // an empty buffer): a fetch is owed whenever the buffer sits empty with
    // bytes remaining. The common paths raise their DMA at the exact event —
    // the output-cycle reload below and the $4015 enable in setEnabled.
    if (this.sampleBufferEmpty && this.bytesRemaining > 0) this.raiseDma(true);

    // The DMC rate table is the exact CPU-cycle period, so decrement-then-test
    // gives `rate` cycles per output (unlike the pulse divider's rate+1).
    if (--this.timer > 0) return;
    this.timer = this.rate;
    if (!this.silence) {
      if ((this.shiftReg & 1) !== 0) {
        if (this.level <= 125) this.level += 2;
      } else if (this.level >= 2) {
        this.level -= 2;
      }
    }
    this.shiftReg >>= 1;
    if (--this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      // Output cycle finished: reload the shift register from the sample buffer.
      // An empty buffer silences the channel until the reader supplies a byte.
      if (this.sampleBufferEmpty) {
        this.silence = true;
      } else {
        this.silence = false;
        this.shiftReg = this.sampleBuffer;
        this.sampleBufferEmpty = true;
        // The emptied buffer immediately schedules the (constant 4-cycle)
        // reload DMA when the sample has bytes left.
        if (this.bytesRemaining > 0) this.raiseDma(true);
      }
    }
  }

  /** The DMA's get cycle: read the sample byte and fill the buffer. Called by
   *  the CPU mid-stall (see its DMC DMA handling). */
  dmaFetch(): void {
    this.dmaRequested = false;
    if (!this.sampleBufferEmpty || this.bytesRemaining === 0) return; // $4015 raced the DMA
    this.sampleBuffer = this.read(this.currentAddr);
    this.sampleBufferEmpty = false;
    this.currentAddr = this.currentAddr >= 0xffff ? 0x8000 : this.currentAddr + 1;
    if (--this.bytesRemaining === 0) {
      if (this.loop) {
        this.currentAddr = this.startAddr;
        this.bytesRemaining = this.startLen;
      } else if (this.irqEnabled) {
        this.irqFlag = true;
      }
    }
  }

  output(): number {
    return this.level;
  }

  serialize(w: NesStateWriter): void {
    w.bool(this.enabled);
    w.bool(this.irqFlag);
    w.bool(this.irqEnabled);
    w.bool(this.loop);
    w.u16(this.rate);
    w.u16(this.timer);
    w.u8(this.level);
    w.u16(this.startAddr);
    w.u16(this.startLen);
    w.u16(this.currentAddr);
    w.u16(this.bytesRemaining);
    w.u8(this.sampleBuffer);
    w.bool(this.sampleBufferEmpty);
    w.u8(this.shiftReg);
    w.u8(this.bitsRemaining);
    w.bool(this.silence);
    w.bool(this.dmaRequested);
    w.bool(this.dmaReload);
  }
  deserialize(r: NesStateReader): void {
    this.enabled = r.bool();
    this.irqFlag = r.bool();
    this.irqEnabled = r.bool();
    this.loop = r.bool();
    this.rate = r.u16();
    this.timer = r.u16();
    this.level = r.u8();
    this.startAddr = r.u16();
    this.startLen = r.u16();
    this.currentAddr = r.u16();
    this.bytesRemaining = r.u16();
    this.sampleBuffer = r.u8();
    this.sampleBufferEmpty = r.bool();
    this.shiftReg = r.u8();
    this.bitsRemaining = r.u8();
    this.silence = r.bool();
    this.dmaRequested = r.bool();
    this.dmaReload = r.bool();
  }
}
