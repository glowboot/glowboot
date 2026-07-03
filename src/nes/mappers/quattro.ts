/**
 * Camerica/Codemasters BF9096 (iNES mapper 232) — Quattro Adventure / Arcade /
 * Sports multicarts.
 *
 * 256 KiB PRG as four 64 KiB blocks of four 16 KiB pages. $8000-$BFFF picks the
 * block (bits 4-3); $C000-$FFFF picks the page (bits 1-0) for the $8000 window,
 * while $C000 is fixed to the block's last page. CHR is RAM; mirroring fixed.
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_232.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

const PRG_BANK = 0x4000; // 16 KiB

export class QuattroMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount: number;
  private readonly mirror: Mirroring;
  private block = 0; // 64 KiB block << 2
  private page = 0; // 16 KiB page within block

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / PRG_BANK);
    this.chr = new Uint8Array(rom.usesChrRam ? rom.chrRamSize || 0x2000 : rom.chrRom.length);
    if (!rom.usesChrRam) this.chr.set(rom.chrRom);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    const bank = addr < 0xc000 ? this.block | this.page : this.block | 3;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x3fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    if (addr < 0xc000) this.block = ((value >> 3) & 3) << 2;
    else this.page = value & 3;
  }

  chrRead(addr: number): number {
    return this.chr[addr & (this.chr.length - 1)]!;
  }
  chrWrite(addr: number, value: number): void {
    this.chr[addr & (this.chr.length - 1)] = value;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.block);
    w.u8(this.page);
    w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.block = r.u8();
    this.page = r.u8();
    r.bytes(this.chr);
  }
}
