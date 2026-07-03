/**
 * Konami VRC1 (iNES mapper 75) — Exciting Boxing, King Kong 2, Tetsuwan Atom.
 *
 * Three 8 KiB switchable PRG banks ($8000/$A000/$C000) + fixed last; two 4 KiB
 * CHR banks whose 5th (high) bit and the mirroring bit live together in $9000.
 * No IRQ. Reference: https://www.nesdev.org/wiki/INES_Mapper_075.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x1000; // 4 KiB

export class Vrc1Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000
  private readonly chrBanks = [0, 0]; // $0000, $1000 (4 KiB)
  private mirror: Mirroring;

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
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region === 3 ? this.prgBankCount - 1 : this.prgBanks[region]!;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    switch (addr & 0xf000) {
      case 0x8000:
        this.prgBanks[0] = value & 0x0f;
        break;
      case 0x9000:
        this.mirror = value & 0x01 ? "horizontal" : "vertical";
        this.chrBanks[0] = (this.chrBanks[0]! & 0x0f) | ((value & 0x02) << 3);
        this.chrBanks[1] = (this.chrBanks[1]! & 0x0f) | ((value & 0x04) << 2);
        break;
      case 0xa000:
        this.prgBanks[1] = value & 0x0f;
        break;
      case 0xc000:
        this.prgBanks[2] = value & 0x0f;
        break;
      case 0xe000:
        this.chrBanks[0] = (this.chrBanks[0]! & 0x10) | (value & 0x0f);
        break;
      case 0xf000:
        this.chrBanks[1] = (this.chrBanks[1]! & 0x10) | (value & 0x0f);
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
    for (const b of this.prgBanks) w.u8(b);
    for (const b of this.chrBanks) w.u8(b);
    writeMirroring(w, this.mirror);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    if (this.chrWritable) r.bytes(this.chr);
  }
}
