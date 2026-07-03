/**
 * Sunsoft FME-7 / 5A / 5B (iNES mapper 69) — Batman: Return of the Joker,
 * Hebereke, Barcode World, Gimmick!.
 *
 * A command/parameter pair: write a command number 0-$F to $8000, then its
 * value to $A000. Commands $0-7 bank 1 KiB CHR windows, $9-$B bank the three
 * switchable 8 KiB PRG windows ($E000 is fixed last), $C sets mirroring, and
 * $D-$F drive a 16-bit cycle-down-counter IRQ that fires on the 0x0000→0xFFFF
 * underflow. Reference: https://www.nesdev.org/wiki/INES_Mapper_069.
 *
 * Command $8 (ROM/RAM banked into $6000-$7FFF) is not modelled — that window is
 * the cartridge's work RAM here. The 5B variant's AY-3-8910 sound (three square
 * channels via the $C000 select / $E000 data ports) IS emulated; its noise and
 * hardware envelope generators are not (Gimmick! and the rest use only tones).
 */

import type { ExpansionAudio } from "../apu/expansion.js";
import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB

/** AY-3-8910 16-step logarithmic volume DAC, ~2 dB/step, normalized to 0..1. */
const AY_VOLUME = (() => {
  const t = new Float32Array(16);
  for (let i = 1; i < 16; i++) t[i] = Math.pow(1.2589, i - 15);
  return t;
})();

/** The 5B's three square-wave tone channels (master clock / 16). */
class Sunsoft5BAudio implements ExpansionAudio {
  private reg = 0;
  private readonly period = [1, 1, 1];
  private readonly timer = [0, 0, 0];
  private readonly level = [0, 0, 0]; // square toggle, 0/1
  private readonly volume = [0, 0, 0]; // 4-bit
  private readonly toneOff = [false, false, false];
  private prescaler = 0;

  select(value: number): void {
    this.reg = value & 0x0f;
  }

  write(value: number): void {
    switch (this.reg) {
      case 0x00:
      case 0x02:
      case 0x04: {
        const ch = this.reg >> 1;
        this.period[ch] = (this.period[ch]! & 0x0f00) | value;
        break;
      }
      case 0x01:
      case 0x03:
      case 0x05: {
        const ch = this.reg >> 1;
        this.period[ch] = (this.period[ch]! & 0x00ff) | ((value & 0x0f) << 8);
        break;
      }
      case 0x07:
        for (let ch = 0; ch < 3; ch++) this.toneOff[ch] = (value & (1 << ch)) !== 0;
        break;
      case 0x08:
      case 0x09:
      case 0x0a:
        this.volume[this.reg - 0x08] = value & 0x0f;
        break;
    }
  }

  clock(): void {
    if (++this.prescaler < 16) return;
    this.prescaler = 0;
    for (let ch = 0; ch < 3; ch++) {
      if (this.timer[ch]! <= 0) {
        this.timer[ch] = this.period[ch]!;
        this.level[ch] = this.level[ch] ? 0 : 1;
      } else {
        this.timer[ch] = this.timer[ch]! - 1;
      }
    }
  }

  output(): number {
    let sum = 0;
    for (let ch = 0; ch < 3; ch++) {
      if (!this.toneOff[ch] && this.level[ch]) sum += AY_VOLUME[this.volume[ch]!]!;
    }
    return sum * 0.115;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.reg);
    for (let i = 0; i < 3; i++) w.u16(this.period[i]!);
    for (let i = 0; i < 3; i++) w.u16(this.timer[i]!);
    for (let i = 0; i < 3; i++) w.u8(this.level[i]!);
    for (let i = 0; i < 3; i++) w.u8(this.volume[i]!);
    for (let i = 0; i < 3; i++) w.bool(this.toneOff[i]!);
    w.u8(this.prescaler);
  }
  deserialize(r: NesStateReader): void {
    this.reg = r.u8();
    for (let i = 0; i < 3; i++) this.period[i] = r.u16();
    for (let i = 0; i < 3; i++) this.timer[i] = r.u16();
    for (let i = 0; i < 3; i++) this.level[i] = r.u8();
    for (let i = 0; i < 3; i++) this.volume[i] = r.u8();
    for (let i = 0; i < 3; i++) this.toneOff[i] = r.bool();
    this.prescaler = r.u8();
  }
}

export class Fme7Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private command = 0;
  private readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  private irqCounterEnabled = false;
  private irqEnabled = false;
  private irqCounter = 0;
  private irqPending = false;
  private readonly sound = new Sunsoft5BAudio();

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / PRG_BANK);
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

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region === 3 ? this.prgBankCount - 1 : this.prgBanks[region]!;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    const block = addr & 0xe000;
    if (block === 0x8000) {
      this.command = value & 0x0f;
      return;
    }
    if (block === 0xc000) {
      this.sound.select(value); // 5B audio register select
      return;
    }
    if (block === 0xe000) {
      this.sound.write(value); // 5B audio data
      return;
    }
    if (block !== 0xa000) return;
    const cmd = this.command;
    if (cmd <= 7) {
      this.chrBanks[cmd] = value;
    } else if (cmd >= 9 && cmd <= 0xb) {
      this.prgBanks[cmd - 9] = value & 0x3f;
    } else if (cmd === 0xc) {
      this.mirror = (["vertical", "horizontal", "single-lower", "single-upper"] as const)[value & 3]!;
    } else if (cmd === 0xd) {
      this.irqEnabled = (value & 0x01) !== 0;
      this.irqCounterEnabled = (value & 0x80) !== 0;
      this.irqPending = false;
    } else if (cmd === 0xe) {
      this.irqCounter = (this.irqCounter & 0xff00) | value;
    } else if (cmd === 0xf) {
      this.irqCounter = (this.irqCounter & 0x00ff) | (value << 8);
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

  tick(cpuCycles: number): void {
    if (!this.irqCounterEnabled) return;
    for (let i = 0; i < cpuCycles; i++) {
      if (this.irqCounter === 0) {
        this.irqCounter = 0xffff;
        if (this.irqEnabled) this.irqPending = true;
      } else {
        this.irqCounter--;
      }
    }
  }
  irqState(): boolean {
    return this.irqPending;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    this.sound.serialize(w);
    w.u8(this.command);
    for (const b of this.prgBanks) w.u8(b);
    for (const b of this.chrBanks) w.u8(b);
    writeMirroring(w, this.mirror);
    w.bool(this.irqCounterEnabled);
    w.bool(this.irqEnabled);
    w.u16(this.irqCounter);
    w.bool(this.irqPending);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.sound.deserialize(r);
    this.command = r.u8();
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    this.irqCounterEnabled = r.bool();
    this.irqEnabled = r.bool();
    this.irqCounter = r.u16();
    this.irqPending = r.bool();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
