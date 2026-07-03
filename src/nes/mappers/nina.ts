/**
 * Mapper 79 (NINA-03/06, AVE/Color Dreams) — a register at $4100-$5FFF selects
 * a 32 KiB PRG bank (bit 3) and an 8 KiB CHR bank (bits 0-2). Mirroring is fixed
 * by the header. Used by AVE's unlicensed catalogue.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

export class Nina03Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount32k: number;
  private readonly chrBankCount8k: number;
  private prgBank = 0;
  private chrBank = 0;
  private readonly mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom;
    this.prgBankCount32k = Math.max(1, rom.prgRom.length / 0x8000);
    this.chrBankCount8k = Math.max(1, rom.chrRom.length / 0x2000);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    return this.prg[(this.prgBank % this.prgBankCount32k) * 0x8000 + (addr & 0x7fff)]!;
  }
  prgWrite(): void {
    /* no $8000-$FFFF registers */
  }
  /** The bank register lives in the $4100-$5FFF half. */
  lowWrite(addr: number, value: number): void {
    if ((addr & 0xe100) === 0x4100) {
      this.prgBank = (value >> 3) & 1;
      this.chrBank = value & 0x07;
    }
  }
  chrRead(addr: number): number {
    return this.chr[(this.chrBank % this.chrBankCount8k) * 0x2000 + (addr & 0x1fff)]!;
  }
  chrWrite(): void {
    /* CHR ROM */
  }
  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgBank);
    w.u8(this.chrBank);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    this.chrBank = r.u8();
  }
}

/**
 * Mapper 113 (NINA-03/06 with mirroring — HES / Sachen multicarts). Same
 * $4100 register as 79, but it also packs a CHR high bit and a mirroring bit:
 * bit 7 = mirroring, bits 3-5 = 32 KiB PRG bank, bit 6 + bits 0-2 = CHR bank.
 */
export class Nina113Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount32k: number;
  private readonly chrBankCount8k: number;
  private prgBank = 0;
  private chrBank = 0;
  private mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom;
    this.prgBankCount32k = Math.max(1, rom.prgRom.length / 0x8000);
    this.chrBankCount8k = Math.max(1, rom.chrRom.length / 0x2000);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    return this.prg[(this.prgBank % this.prgBankCount32k) * 0x8000 + (addr & 0x7fff)]!;
  }
  prgWrite(): void {
    /* no $8000-$FFFF registers */
  }
  lowWrite(addr: number, value: number): void {
    if ((addr & 0xe100) === 0x4100) {
      this.prgBank = (value >> 3) & 0x07;
      this.chrBank = (value & 0x07) | ((value & 0x40) >> 3);
      this.mirror = value & 0x80 ? "vertical" : "horizontal";
    }
  }
  chrRead(addr: number): number {
    return this.chr[(this.chrBank % this.chrBankCount8k) * 0x2000 + (addr & 0x1fff)]!;
  }
  chrWrite(): void {
    /* CHR ROM */
  }
  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgBank);
    w.u8(this.chrBank);
    writeMirroring(w, this.mirror);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    this.chrBank = r.u8();
    this.mirror = readMirroring(r);
  }
}
