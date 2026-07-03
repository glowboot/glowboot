/**
 * Mapper 9 (MMC2 — Punch-Out!!) and mapper 10 (MMC4 — Fire Emblem, Famicom
 * Wars). Both switch CHR via a "latch" that flips when the PPU fetches specific
 * tiles ($0FD8/$0FE8 for the $0000 half, $1FD8/$1FE8 for the $1000 half), so
 * each 4 KiB CHR window has two bank registers selected by its latch.
 *
 * MMC2 banks PRG in 8 KiB (one switchable + three fixed); MMC4 in 16 KiB (one
 * switchable + the last fixed). Reference: https://www.nesdev.org/wiki/MMC2.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

abstract class LatchMapper implements Mapper {
  protected readonly prg: Uint8Array;
  protected readonly chr: Uint8Array;
  protected readonly prgBankCount8k: number;
  protected readonly chrBankCount4k: number;
  protected prgBank = 0;
  // CHR: [latch0 FD, latch0 FE, latch1 FD, latch1 FE] bank registers.
  protected readonly chrBanks = [0, 0, 0, 0];
  protected latch0 = 1; // FE
  protected latch1 = 1;
  protected mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom.length > 0 ? rom.chrRom : new Uint8Array(0x2000);
    this.prgBankCount8k = Math.max(1, rom.prgRom.length / 0x2000);
    this.chrBankCount4k = Math.max(1, this.chr.length / 0x1000);
    this.mirror = rom.mirroring;
  }

  abstract prgRead(addr: number): number;

  prgWrite(addr: number, value: number): void {
    switch (addr & 0xf000) {
      case 0xa000:
        this.prgBank = value & 0x0f;
        break;
      case 0xb000:
        this.chrBanks[0] = value & 0x1f;
        break;
      case 0xc000:
        this.chrBanks[1] = value & 0x1f;
        break;
      case 0xd000:
        this.chrBanks[2] = value & 0x1f;
        break;
      case 0xe000:
        this.chrBanks[3] = value & 0x1f;
        break;
      case 0xf000:
        this.mirror = value & 1 ? "horizontal" : "vertical";
        break;
    }
  }

  chrRead(addr: number): number {
    const bank = addr < 0x1000 ? this.chrBanks[this.latch0]! : this.chrBanks[2 + this.latch1]!;
    const byte = this.chr[((bank % this.chrBankCount4k) * 0x1000 + (addr & 0x0fff)) % this.chr.length]!;
    // Latch flips on the tile fetch — after this byte is read.
    if (addr >= 0x0fd8 && addr <= 0x0fdf) this.latch0 = 0;
    else if (addr >= 0x0fe8 && addr <= 0x0fef) this.latch0 = 1;
    else if (addr >= 0x1fd8 && addr <= 0x1fdf) this.latch1 = 0;
    else if (addr >= 0x1fe8 && addr <= 0x1fef) this.latch1 = 1;
    return byte;
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
    w.u8(this.latch0);
    w.u8(this.latch1);
    writeMirroring(w, this.mirror);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.latch0 = r.u8();
    this.latch1 = r.u8();
    this.mirror = readMirroring(r);
  }
}

/** Mapper 9 (MMC2): 8 KiB PRG — switchable $8000, fixed last-3 above. */
export class Mmc2Mapper extends LatchMapper {
  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region === 0 ? this.prgBank : this.prgBankCount8k - (4 - region);
    return this.prg[(bank % this.prgBankCount8k) * 0x2000 + (addr & 0x1fff)]!;
  }
}

/** Mapper 10 (MMC4): 16 KiB PRG — switchable $8000, fixed last $C000. */
export class Mmc4Mapper extends LatchMapper {
  prgRead(addr: number): number {
    const banks16 = this.prgBankCount8k >> 1;
    const bank16 = addr < 0xc000 ? this.prgBank : banks16 - 1;
    return this.prg[((bank16 % banks16) * 0x4000 + (addr & 0x3fff)) % this.prg.length]!;
  }
}
