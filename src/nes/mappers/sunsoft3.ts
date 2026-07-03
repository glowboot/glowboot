/**
 * Sunsoft-3 (iNES mapper 67) — Fantasy Zone 2, Mito Koumon 2.
 *
 * 16 KiB switchable PRG at $8000 (fixed last at $C000), four 2 KiB CHR banks,
 * runtime mirroring, and a 16-bit cycle-down-counter IRQ whose value is loaded
 * one byte per write to $C800 — a write-order toggle (reset by any $D800 write)
 * picks the high byte first, then the low byte.
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_067.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x4000; // 16 KiB
const CHR_BANK = 0x800; // 2 KiB

export class Sunsoft3Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private prgBank = 0;
  private readonly chrBanks = [0, 0, 0, 0];
  private mirror: Mirroring;

  private irqEnabled = false;
  private irqCounter = 0;
  private irqHighNext = true;
  private irqPending = false;

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

  prgRead(addr: number): number {
    const bank = addr < 0xc000 ? this.prgBank : this.prgBankCount - 1;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x3fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    switch (addr & 0xf800) {
      case 0x8800:
        this.chrBanks[0] = value;
        break;
      case 0x9800:
        this.chrBanks[1] = value;
        break;
      case 0xa800:
        this.chrBanks[2] = value;
        break;
      case 0xb800:
        this.chrBanks[3] = value;
        break;
      case 0xc800:
        if (this.irqHighNext) this.irqCounter = (this.irqCounter & 0x00ff) | (value << 8);
        else this.irqCounter = (this.irqCounter & 0xff00) | value;
        this.irqHighNext = !this.irqHighNext;
        break;
      case 0xd800:
        this.irqEnabled = (value & 0x10) !== 0;
        this.irqHighNext = true;
        this.irqPending = false;
        break;
      case 0xe800:
        this.mirror = (["vertical", "horizontal", "single-lower", "single-upper"] as const)[value & 3]!;
        break;
      case 0xf800:
        this.prgBank = value;
        break;
    }
  }

  chrRead(addr: number): number {
    const bank = this.chrBanks[(addr >> 11) & 3]!;
    return this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x7ff)) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    const bank = this.chrBanks[(addr >> 11) & 3]!;
    this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x7ff)) % this.chr.length] = value;
  }

  tick(cpuCycles: number): void {
    if (!this.irqEnabled) return;
    for (let i = 0; i < cpuCycles; i++) {
      if (this.irqCounter === 0) {
        this.irqCounter = 0xffff;
        this.irqPending = true;
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
    w.u8(this.prgBank);
    for (const v of this.chrBanks) w.u8(v);
    writeMirroring(w, this.mirror);
    w.bool(this.irqEnabled);
    w.u16(this.irqCounter);
    w.bool(this.irqHighNext);
    w.bool(this.irqPending);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    this.irqEnabled = r.bool();
    this.irqCounter = r.u16();
    this.irqHighNext = r.bool();
    this.irqPending = r.bool();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
