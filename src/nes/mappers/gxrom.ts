/**
 * Mapper 66 (GxROM / MHROM) — a single write register at $8000-$FFFF selects a
 * 32 KiB PRG bank (bits 4-5) and an 8 KiB CHR bank (bits 0-1). Dragon Power,
 * Super Mario Bros. + Duck Hunt, … Mirroring is fixed by the header.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

export class GxromMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount: number; // 32 KiB units
  private readonly chrBankCount: number; // 8 KiB units
  private readonly mirror: Mirroring;
  private prgBank = 0;
  private chrBank = 0;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / 0x8000);
    this.chrBankCount = Math.max(1, rom.chrRom.length / 0x2000);
    this.mirror = rom.mirroring;
    // All PRG is switchable (no fixed bank), and these carts place the reset
    // vector only in the last bank — so power on with it selected.
    this.prgBank = this.prgBankCount - 1;
  }

  prgRead(addr: number): number {
    return this.prg[(this.prgBank % this.prgBankCount) * 0x8000 + (addr & 0x7fff)]!;
  }
  prgWrite(addr: number, value: number): void {
    // Bus conflict: GxROM writes the bank from a ROM lookup table, so the CPU
    // value is ANDed with the ROM byte currently visible at `addr`.
    value &= this.prg[(this.prgBank % this.prgBankCount) * 0x8000 + (addr & 0x7fff)]!;
    this.prgBank = (value >> 4) & 0x03;
    this.chrBank = value & 0x03;
  }
  chrRead(addr: number): number {
    return this.chr[(this.chrBank % this.chrBankCount) * 0x2000 + (addr & 0x1fff)]!;
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
