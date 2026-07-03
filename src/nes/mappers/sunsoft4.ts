/**
 * Mapper 68 (Sunsoft-4) — After Burner, Maharaja, … A 16 KiB PRG bank at $8000
 * (last fixed at $C000), four 2 KiB CHR banks, and $E000 mirroring control.
 * (The CHR-ROM-as-nametable feature is not modelled — it's only used by After
 * Burner's special effects.)
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

export class Sunsoft4Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount16k: number;
  private readonly chrBankCount2k: number;
  private prgBank = 0;
  private readonly chrBanks = [0, 0, 0, 0];
  private mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom.length > 0 ? rom.chrRom : new Uint8Array(0x2000);
    this.prgBankCount16k = Math.max(1, rom.prgRom.length / 0x4000);
    this.chrBankCount2k = Math.max(1, this.chr.length / 0x800);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    const bank = addr < 0xc000 ? this.prgBank : this.prgBankCount16k - 1;
    return this.prg[(bank % this.prgBankCount16k) * 0x4000 + (addr & 0x3fff)]!;
  }
  prgWrite(addr: number, value: number): void {
    switch (addr & 0xf000) {
      case 0x8000:
        this.chrBanks[0] = value;
        break;
      case 0x9000:
        this.chrBanks[1] = value;
        break;
      case 0xa000:
        this.chrBanks[2] = value;
        break;
      case 0xb000:
        this.chrBanks[3] = value;
        break;
      case 0xe000:
        this.mirror = ["vertical", "horizontal", "single-lower", "single-upper"][value & 3] as Mirroring;
        break;
      case 0xf000:
        this.prgBank = value & 0x0f;
        break;
    }
  }
  chrRead(addr: number): number {
    const bank = this.chrBanks[(addr >> 11) & 3]!;
    return this.chr[((bank % this.chrBankCount2k) * 0x800 + (addr & 0x7ff)) % this.chr.length]!;
  }
  chrWrite(): void {
    /* CHR ROM */
  }
  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgBank);
    for (const v of this.chrBanks) w.u8(v);
    writeMirroring(w, this.mirror);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
  }
}
