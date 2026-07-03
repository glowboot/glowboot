/**
 * Mapper 0 (NROM) — no banking. PRG ROM is 16 KiB (mirrored across
 * $8000-$FFFF) or 32 KiB (direct); CHR is a fixed 8 KiB of ROM or RAM. The
 * mirroring is whatever the header fixed.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

export class NromMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
  }

  prgRead(addr: number): number {
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }
  prgWrite(): void {
    /* no registers */
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
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    if (this.chrWritable) r.bytes(this.chr);
  }
}
