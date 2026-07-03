/**
 * Mapper 70 (Bandai) and 152 (Bandai, one-screen). A single $8000-$FFFF write
 * selects a 16 KiB PRG bank (bits 4-6, $8000, last bank fixed at $C000) and an
 * 8 KiB CHR bank (bits 0-3). Mapper 152 also uses bit 7 to pick single-screen
 * nametable; mapper 70 keeps the header mirroring.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

export class Bandai74Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount16k: number;
  private readonly chrBankCount8k: number;
  private prgBank = 0;
  private chrBank = 0;
  private mirror: Mirroring;

  constructor(
    rom: NesRom,
    private readonly oneScreen: boolean // mapper 152
  ) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom;
    this.prgBankCount16k = Math.max(1, rom.prgRom.length / 0x4000);
    this.chrBankCount8k = Math.max(1, rom.chrRom.length / 0x2000);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    const bank = addr < 0xc000 ? this.prgBank : this.prgBankCount16k - 1;
    return this.prg[(bank % this.prgBankCount16k) * 0x4000 + (addr & 0x3fff)]!;
  }
  prgWrite(_addr: number, value: number): void {
    this.prgBank = (value >> 4) & 7;
    this.chrBank = value & 0x0f;
    if (this.oneScreen) this.mirror = value & 0x80 ? "single-upper" : "single-lower";
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
