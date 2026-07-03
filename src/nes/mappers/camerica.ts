/**
 * Mapper 71 (Camerica / Codemasters BF909x) — UxROM-like: a switchable 16 KiB
 * PRG bank at $8000-$BFFF with the last bank fixed at $C000-$FFFF; the bank is
 * selected by writes to $C000-$FFFF. Micro Machines, Fire Hawk, Bee 52, …
 * CHR is 8 KiB of RAM. (The BF9097 single-screen-mirroring quirk at $8000-$9FFF
 * is not modelled; affects only Fire Hawk.)
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

export class CamericaMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly mirror: Mirroring;
  private bank = 0;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = rom.prgRom.length / 0x4000;
    this.mirror = rom.mirroring;
    this.chrWritable = rom.usesChrRam;
    this.chr = rom.usesChrRam ? new Uint8Array(rom.chrRamSize || 0x2000) : rom.chrRom;
  }

  prgRead(addr: number): number {
    const bank = addr < 0xc000 ? this.bank : this.prgBankCount - 1;
    return this.prg[(bank % this.prgBankCount) * 0x4000 + (addr & 0x3fff)]!;
  }
  prgWrite(addr: number, value: number): void {
    if (addr >= 0xc000) this.bank = value & 0x0f;
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
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.bank = r.u8();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
