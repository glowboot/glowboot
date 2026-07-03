/**
 * BNROM / NINA-001 (iNES mapper 34) — Deadly Towers (BNROM), Impossible
 * Mission II / F-15 City War (NINA-001).
 *
 * Two boards share a number. BNROM switches a 32 KiB PRG bank by writing
 * $8000-$FFFF and uses CHR RAM. NINA-001 instead exposes registers in the
 * work-RAM window — $7FFD = 32 KiB PRG, $7FFE/$7FFF = two 4 KiB CHR banks. Both
 * behaviours coexist here without conflict (a cart drives only its own).
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_034.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

const PRG_BANK = 0x8000; // 32 KiB
const CHR_BANK = 0x1000; // 4 KiB

export class BnromMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private readonly mirror: Mirroring;
  private prgBank = 0;
  private readonly chrBanks = [0, 1]; // $0000, $1000 (NINA-001)

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / PRG_BANK);
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chrBankCount = Math.max(1, this.chr.length / CHR_BANK);
  }

  prgRead(addr: number): number {
    return this.prg[((this.prgBank % this.prgBankCount) * PRG_BANK + (addr & 0x7fff)) % this.prg.length]!;
  }
  prgWrite(_addr: number, value: number): void {
    this.prgBank = value; // BNROM: 32 KiB select
  }
  lowWrite(addr: number, value: number): void {
    switch (addr) {
      case 0x7ffd:
        this.prgBank = value;
        break;
      case 0x7ffe:
        this.chrBanks[0] = value;
        break;
      case 0x7fff:
        this.chrBanks[1] = value;
        break;
    }
  }

  chrRead(addr: number): number {
    const bank = this.chrBanks[(addr >> 12) & 1]!;
    return this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0xfff)) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    const bank = this.chrBanks[(addr >> 12) & 1]!;
    this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0xfff)) % this.chr.length] = value;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgBank);
    for (const v of this.chrBanks) w.u8(v);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
