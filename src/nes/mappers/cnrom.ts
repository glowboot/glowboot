/**
 * Mapper 3 (CNROM) — fixed PRG, a switchable 8 KiB CHR ROM bank selected by any
 * write to $8000-$FFFF. Arkanoid, Gradius, Bump 'n' Jump, … Mirroring is fixed
 * by the header.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

export class CnromMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrBankCount: number;
  private readonly mirror: Mirroring;
  private bank = 0;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom;
    this.chrBankCount = Math.max(1, rom.chrRom.length / 0x2000);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }
  prgWrite(_addr: number, value: number): void {
    this.bank = value & 0xff;
  }
  chrRead(addr: number): number {
    return this.chr[(this.bank % this.chrBankCount) * 0x2000 + (addr & 0x1fff)]!;
  }
  chrWrite(): void {
    /* CHR ROM — not writable */
  }
  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.bank);
  }
  deserialize(r: NesStateReader): void {
    this.bank = r.u8();
  }
}
