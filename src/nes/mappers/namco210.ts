/**
 * Namco 175 / 340 (iNES mapper 210) — Famicom Jump, Splatterhouse: Wanpaku
 * Graffiti, Family Circuit '91, Chibi Maruko-chan. A cut-down Namco 163 with no
 * sound and no IRQ: eight 1 KiB CHR banks ($8000-$BFFF) and three switchable
 * 8 KiB PRG banks ($E000/$E800/$F000) plus a fixed last bank.
 *
 * The submapper picks the mirroring source: 175 (submapper 1) is hardwired from
 * the header; 340 (submapper 2) takes it from $E000 bits 7-6. Bare iNES
 * (submapper 0) defaults to the hardwired 175 behaviour.
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_210.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB
const MIRROR_340 = ["single-lower", "vertical", "single-upper", "horizontal"] as const;

export class Namco210Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private readonly controlsMirror: boolean; // Namco 340 (submapper 2)
  private readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / PRG_BANK);
    this.controlsMirror = rom.submapper === 2;
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
    const block = addr & 0xf800;
    if (block >= 0x8000 && block <= 0xb800) {
      this.chrBanks[(block - 0x8000) >> 11] = value;
    } else if (block === 0xe000) {
      this.prgBanks[0] = value & 0x3f;
      if (this.controlsMirror) this.mirror = MIRROR_340[(value >> 6) & 3]!;
    } else if (block === 0xe800) {
      this.prgBanks[1] = value & 0x3f;
    } else if (block === 0xf000) {
      this.prgBanks[2] = value & 0x3f;
    }
  }

  chrRead(addr: number): number {
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    return this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x3ff)) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x3ff)) % this.chr.length] = value;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    for (const v of this.prgBanks) w.u8(v);
    for (const v of this.chrBanks) w.u8(v);
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
