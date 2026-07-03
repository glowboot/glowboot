/**
 * Mapper 7 (AxROM) — Battletoads, Marble Madness, Wizards & Warriors, …
 *
 * A switchable 32 KiB PRG bank across $8000-$FFFF; bit 4 of the bank register
 * selects single-screen mirroring (nametable A or B). CHR is 8 KiB of RAM.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

export class AxromMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number; // 32 KiB units
  private bank = 0;
  private mirror: Mirroring = "single-lower";

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / 0x8000);
    this.chrWritable = rom.usesChrRam;
    this.chr = rom.usesChrRam ? new Uint8Array(rom.chrRamSize || 0x2000) : rom.chrRom;
  }

  prgRead(addr: number): number {
    return this.prg[(this.bank % this.prgBankCount) * 0x8000 + (addr & 0x7fff)]!;
  }
  prgWrite(_addr: number, value: number): void {
    this.bank = value & 0x07;
    this.mirror = value & 0x10 ? "single-upper" : "single-lower";
  }
  chrRead(addr: number): number {
    return this.chr[addr & 0x1fff]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[addr & 0x1fff] = value;
  }
  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.bank);
    writeMirroring(w, this.mirror);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.bank = r.u8();
    this.mirror = readMirroring(r);
    if (this.chrWritable) r.bytes(this.chr);
  }
}
