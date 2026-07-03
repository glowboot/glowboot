/**
 * Konami VRC6 (iNES mappers 24 / 26) — Akumajou Densetsu (Castlevania III JP),
 * Madara, Esper Dream 2. The first expansion-audio mapper here: two pulse
 * channels and a sawtooth summed into the 2A03 mix.
 *
 * Banking is VRC4-like (16 KiB PRG at $8000, 8 KiB at $C000, fixed last 8 KiB,
 * eight 1 KiB CHR banks, VRC4 latch/prescaler IRQ). Mapper 24 (VRC6a) wires the
 * register pins A0/A1 normally; mapper 26 (VRC6b) swaps them. Only $B003 CHR
 * mode 0 (eight direct 1 KiB banks) is modelled.
 * References: https://www.nesdev.org/wiki/VRC6 and /VRC6_audio.
 */

import type { ExpansionAudio } from "../apu/expansion.js";
import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG16 = 0x4000;
const PRG8 = 0x2000;
const CHR_BANK = 0x400;

class Vrc6Pulse {
  enabled = false;
  mode = false;
  duty = 0;
  volume = 0;
  period = 0;
  private timer = 0;
  private step = 0;

  write(sub: number, value: number): void {
    if (sub === 0) {
      this.mode = (value & 0x80) !== 0;
      this.duty = (value >> 4) & 0x07;
      this.volume = value & 0x0f;
    } else if (sub === 1) {
      this.period = (this.period & 0x0f00) | value;
    } else if (sub === 2) {
      this.period = (this.period & 0x00ff) | ((value & 0x0f) << 8);
      this.enabled = (value & 0x80) !== 0;
      if (!this.enabled) this.step = 0;
    }
  }

  clock(shift: number): void {
    if (!this.enabled) return;
    if (this.timer === 0) {
      this.timer = this.period >> shift;
      this.step = (this.step + 1) & 0x0f;
    } else {
      this.timer--;
    }
  }

  output(): number {
    if (!this.enabled) return 0;
    if (this.mode || this.step <= this.duty) return this.volume;
    return 0;
  }

  serialize(w: NesStateWriter): void {
    w.bool(this.enabled);
    w.bool(this.mode);
    w.u8(this.duty);
    w.u8(this.volume);
    w.u16(this.period);
    w.u16(this.timer);
    w.u8(this.step);
  }
  deserialize(r: NesStateReader): void {
    this.enabled = r.bool();
    this.mode = r.bool();
    this.duty = r.u8();
    this.volume = r.u8();
    this.period = r.u16();
    this.timer = r.u16();
    this.step = r.u8();
  }
}

class Vrc6Saw {
  enabled = false;
  rate = 0;
  period = 0;
  private timer = 0;
  private accStep = 0;
  private accumulator = 0;

  write(sub: number, value: number): void {
    if (sub === 0) {
      this.rate = value & 0x3f;
    } else if (sub === 1) {
      this.period = (this.period & 0x0f00) | value;
    } else if (sub === 2) {
      this.period = (this.period & 0x00ff) | ((value & 0x0f) << 8);
      this.enabled = (value & 0x80) !== 0;
      if (!this.enabled) {
        this.accumulator = 0;
        this.accStep = 0;
      }
    }
  }

  clock(shift: number): void {
    if (!this.enabled) return;
    if (this.timer === 0) {
      this.timer = this.period >> shift;
      this.accStep++;
      if ((this.accStep & 1) === 0) {
        if (this.accStep === 14) {
          this.accumulator = 0;
          this.accStep = 0;
        } else {
          this.accumulator = (this.accumulator + this.rate) & 0xff;
        }
      }
    } else {
      this.timer--;
    }
  }

  output(): number {
    return this.enabled ? (this.accumulator >> 3) & 0x1f : 0;
  }

  serialize(w: NesStateWriter): void {
    w.bool(this.enabled);
    w.u8(this.rate);
    w.u16(this.period);
    w.u16(this.timer);
    w.u8(this.accStep);
    w.u8(this.accumulator);
  }
  deserialize(r: NesStateReader): void {
    this.enabled = r.bool();
    this.rate = r.u8();
    this.period = r.u16();
    this.timer = r.u16();
    this.accStep = r.u8();
    this.accumulator = r.u8();
  }
}

class Vrc6Audio implements ExpansionAudio {
  readonly pulse1 = new Vrc6Pulse();
  readonly pulse2 = new Vrc6Pulse();
  readonly saw = new Vrc6Saw();
  private halt = false;
  private shift = 0;

  setControl(value: number): void {
    this.halt = (value & 0x01) !== 0;
    this.shift = value & 0x04 ? 8 : value & 0x02 ? 4 : 0;
  }

  clock(): void {
    if (this.halt) return;
    this.pulse1.clock(this.shift);
    this.pulse2.clock(this.shift);
    this.saw.clock(this.shift);
  }

  output(): number {
    return (this.pulse1.output() + this.pulse2.output()) * 0.00845 + this.saw.output() * 0.00422;
  }

  serialize(w: NesStateWriter): void {
    this.pulse1.serialize(w);
    this.pulse2.serialize(w);
    this.saw.serialize(w);
    w.bool(this.halt);
    w.u8(this.shift);
  }
  deserialize(r: NesStateReader): void {
    this.pulse1.deserialize(r);
    this.pulse2.deserialize(r);
    this.saw.deserialize(r);
    this.halt = r.bool();
    this.shift = r.u8();
  }
}

export class Vrc6Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prg16Count: number;
  private readonly prg8Count: number;
  private readonly chrBankCount: number;
  private readonly swapPins: boolean; // VRC6b
  private readonly sound = new Vrc6Audio();

  private prgBank16 = 0;
  private prgBank8 = 0;
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  private irqLatch = 0;
  private irqCounter = 0;
  private irqPrescaler = 0;
  private irqEnabled = false;
  private irqEnableAfterAck = false;
  private irqCycleMode = false;
  private irqPending = false;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prg16Count = Math.max(1, rom.prgRom.length / PRG16);
    this.prg8Count = Math.max(1, rom.prgRom.length / PRG8);
    this.swapPins = rom.mapper === 26;
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chrBankCount = Math.max(1, this.chr.length / CHR_BANK);
  }

  audio(): ExpansionAudio {
    return this.sound;
  }

  /** VRC6b swaps the A0 and A1 register pins. */
  private sub(addr: number): number {
    if (!this.swapPins) return addr & 3;
    return ((addr & 0x01) << 1) | ((addr & 0x02) >> 1);
  }

  prgRead(addr: number): number {
    if (addr < 0xc000) {
      return this.prg[((this.prgBank16 % this.prg16Count) * PRG16 + (addr & 0x3fff)) % this.prg.length]!;
    }
    const bank = addr < 0xe000 ? this.prgBank8 : this.prg8Count - 1;
    return this.prg[((bank % this.prg8Count) * PRG8 + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    const sub = this.sub(addr);
    switch (addr & 0xf000) {
      case 0x8000:
        this.prgBank16 = value;
        break;
      case 0x9000:
        if (sub === 3) this.sound.setControl(value);
        else this.sound.pulse1.write(sub, value);
        break;
      case 0xa000:
        this.sound.pulse2.write(sub, value);
        break;
      case 0xb000:
        if (sub === 3) {
          this.mirror = (["vertical", "horizontal", "single-lower", "single-upper"] as const)[(value >> 2) & 3]!;
        } else {
          this.sound.saw.write(sub, value);
        }
        break;
      case 0xc000:
        this.prgBank8 = value;
        break;
      case 0xd000:
        this.chrBanks[sub] = value;
        break;
      case 0xe000:
        this.chrBanks[4 + sub] = value;
        break;
      case 0xf000:
        if (sub === 0) this.irqLatch = value;
        else if (sub === 1) {
          this.irqEnableAfterAck = (value & 0x01) !== 0;
          this.irqEnabled = (value & 0x02) !== 0;
          this.irqCycleMode = (value & 0x04) !== 0;
          this.irqPending = false;
          if (this.irqEnabled) {
            this.irqCounter = this.irqLatch;
            this.irqPrescaler = 0;
          }
        } else if (sub === 2) {
          this.irqPending = false;
          this.irqEnabled = this.irqEnableAfterAck;
        }
        break;
    }
  }

  chrRead(addr: number): number {
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    return this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x3ff)) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x3ff)) % this.chr.length] = value;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  private clockCounter(): void {
    if (this.irqCounter === 0xff) {
      this.irqCounter = this.irqLatch;
      this.irqPending = true;
    } else {
      this.irqCounter++;
    }
  }

  tick(cpuCycles: number): void {
    if (!this.irqEnabled) return;
    for (let i = 0; i < cpuCycles; i++) {
      if (this.irqCycleMode) {
        this.clockCounter();
      } else {
        this.irqPrescaler += 3;
        if (this.irqPrescaler >= 341) {
          this.irqPrescaler -= 341;
          this.clockCounter();
        }
      }
    }
  }
  irqState(): boolean {
    return this.irqPending;
  }

  serialize(w: NesStateWriter): void {
    this.sound.serialize(w);
    w.u8(this.prgBank16);
    w.u8(this.prgBank8);
    for (const b of this.chrBanks) w.u8(b);
    writeMirroring(w, this.mirror);
    w.u8(this.irqLatch);
    w.u8(this.irqCounter);
    w.u16(this.irqPrescaler);
    w.bool(this.irqEnabled);
    w.bool(this.irqEnableAfterAck);
    w.bool(this.irqCycleMode);
    w.bool(this.irqPending);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.sound.deserialize(r);
    this.prgBank16 = r.u8();
    this.prgBank8 = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    this.irqLatch = r.u8();
    this.irqCounter = r.u8();
    this.irqPrescaler = r.u16();
    this.irqEnabled = r.bool();
    this.irqEnableAfterAck = r.bool();
    this.irqCycleMode = r.bool();
    this.irqPending = r.bool();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
