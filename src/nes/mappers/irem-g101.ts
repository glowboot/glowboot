/**
 * Mapper 32 (Irem G-101) — Image Fight, Kickle Cubicle, Magical Kids Doropie,
 * Ai Sensei no Oshiete. Two switchable 8 KiB PRG banks plus a PRG-mode bit that
 * swaps which of $8000/$C000 is switchable, eight 1 KiB CHR banks, and a
 * mirroring bit.
 *
 * Registers (https://www.nesdev.org/wiki/INES_Mapper_032):
 *   $8000-$8FFF  PRG bank A (8 KiB)
 *   $9000-$9FFF  bit 0 mirroring (0=vertical, 1=horizontal), bit 1 PRG mode
 *   $A000-$AFFF  PRG bank B (8 KiB, always at $A000)
 *   $B000-$B007  CHR bank (1 KiB) selected by the low 3 address bits
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

export class IremG101Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number; // 8 KiB units
  private readonly chrBankCount: number; // 1 KiB units

  private prgA = 0;
  private prgB = 0;
  private prgMode = 0;
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / 0x2000);
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chrBankCount = Math.max(1, this.chr.length / 0x400);
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const penult = this.prgBankCount - 2;
    let bank: number;
    if (region === 1) bank = this.prgB;
    else if (region === 3) bank = this.prgBankCount - 1;
    else if (this.prgMode === 0) bank = region === 0 ? this.prgA : penult;
    else bank = region === 0 ? penult : this.prgA; // mode 1 swaps $8000 / $C000
    return this.prg[((bank % this.prgBankCount) * 0x2000 + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    switch (addr & 0xf000) {
      case 0x8000:
        this.prgA = value & 0x1f;
        break;
      case 0x9000:
        this.mirror = value & 1 ? "horizontal" : "vertical";
        this.prgMode = (value >> 1) & 1;
        break;
      case 0xa000:
        this.prgB = value & 0x1f;
        break;
      case 0xb000:
        this.chrBanks[addr & 7] = value;
        break;
    }
  }

  chrRead(addr: number): number {
    return this.chr[this.chrOffset(addr)]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[this.chrOffset(addr)] = value;
  }
  private chrOffset(addr: number): number {
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    return ((bank % this.chrBankCount) * 0x400 + (addr & 0x3ff)) % this.chr.length;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgA);
    w.u8(this.prgB);
    w.u8(this.prgMode);
    for (const b of this.chrBanks) w.u8(b);
    writeMirroring(w, this.mirror);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.prgA = r.u8();
    this.prgB = r.u8();
    this.prgMode = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    if (this.chrWritable) r.bytes(this.chr);
  }
}
