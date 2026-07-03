/**
 * Small discrete-logic mappers for a handful of licensed carts that don't fit
 * the common NROM/UxROM/CNROM shapes:
 *
 *   93  Sunsoft-2 (Sunsoft-3R) — 16 KiB PRG bank at $8000 (bits 4-6), $C000
 *       fixed last, 8 KiB CHR-RAM. Fantasy Zone, Shanghai.
 *   94  UN1ROM — UxROM with the PRG bank in bits 2-4. Senjou no Ookami.
 *   180 Nichibutsu UNROM — reverse UxROM: $8000 fixed first, $C000 switchable.
 *       Crazy Climber.
 *   97  Irem TAM-S1 — $8000 fixed last, $C000 switchable (bits 0-3), mirroring
 *       from bits 6-7. Kaiketsu Yanchamaru.
 *   184 Sunsoft-1 — CHR only: a $6000-$7FFF latch banking two 4 KiB CHR windows.
 *       Atlantis no Nazo, Kanshakudama Nage Kantarou.
 *
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_093 / _094 / _097 / _180 / _184.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

/** Base for the four single-latch 16 KiB-PRG + 8 KiB-CHR boards (93/94/97/180).
 *  Subclasses decode the write and place the switchable/fixed 16 KiB windows. */
abstract class SingleLatch implements Mapper {
  protected readonly prg: Uint8Array;
  protected readonly chr: Uint8Array;
  protected readonly chrWritable: boolean;
  protected readonly prgBankCount: number; // 16 KiB units
  protected bank = 0;
  protected mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / 0x4000);
    this.mirror = rom.mirroring;
    if (rom.usesChrRam || rom.chrRom.length === 0) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
  }

  protected abstract banks(high: boolean): number;

  prgRead(addr: number): number {
    const bank = this.banks((addr & 0x4000) !== 0);
    return this.prg[((bank % this.prgBankCount) * 0x4000 + (addr & 0x3fff)) % this.prg.length]!;
  }
  abstract prgWrite(addr: number, value: number): void;

  chrRead(addr: number): number {
    return this.chr[(addr & 0x1fff) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[(addr & 0x1fff) % this.chr.length] = value;
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

/** Mapper 93 (Sunsoft-2). */
export class Sunsoft2Mapper extends SingleLatch {
  protected banks(high: boolean): number {
    return high ? this.prgBankCount - 1 : this.bank;
  }
  prgWrite(_addr: number, value: number): void {
    this.bank = (value >> 4) & 0x0f;
  }
}

/** Mapper 94 (UN1ROM). */
export class Un1romMapper extends SingleLatch {
  protected banks(high: boolean): number {
    return high ? this.prgBankCount - 1 : this.bank;
  }
  prgWrite(_addr: number, value: number): void {
    this.bank = (value >> 2) & 0x07;
  }
}

/** Mapper 180 (Nichibutsu, reverse UxROM). */
export class Nichibutsu180Mapper extends SingleLatch {
  protected banks(high: boolean): number {
    return high ? this.bank : 0; // $8000 fixed first, $C000 switchable
  }
  prgWrite(_addr: number, value: number): void {
    this.bank = value & 0x0f;
  }
}

/** Mapper 97 (Irem TAM-S1). */
export class IremTamS1Mapper extends SingleLatch {
  protected banks(high: boolean): number {
    return high ? this.bank : this.prgBankCount - 1; // $8000 fixed last, $C000 switchable
  }
  prgWrite(_addr: number, value: number): void {
    this.bank = value & 0x0f;
    this.mirror = ((value >> 6) & 3) === 2 ? "horizontal" : "vertical";
  }
}

/** Mapper 184 (Sunsoft-1) — fixed PRG, two switchable 4 KiB CHR windows selected
 *  by a $6000-$7FFF latch (low nibble → $0000, high nibble → $1000; the high
 *  bank always sits in the second half of CHR). */
export class Sunsoft1Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrBankCount: number; // 4 KiB units
  private readonly mirror: Mirroring;
  private chrLo = 0;
  private chrHi = 0;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom.length ? rom.chrRom : new Uint8Array(0x2000);
    this.chrBankCount = Math.max(1, this.chr.length / 0x1000);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }
  prgWrite(): void {
    /* CHR latch is at $6000-$7FFF (lowWrite) */
  }
  lowWrite(_addr: number, value: number): void {
    this.chrLo = value & 0x07;
    this.chrHi = ((value >> 4) & 0x07) | 0x08; // high window is in banks 8-15
  }

  chrRead(addr: number): number {
    const bank = addr < 0x1000 ? this.chrLo : this.chrHi;
    return this.chr[((bank % this.chrBankCount) * 0x1000 + (addr & 0x0fff)) % this.chr.length]!;
  }
  chrWrite(): void {
    /* CHR ROM */
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.chrLo);
    w.u8(this.chrHi);
  }
  deserialize(r: NesStateReader): void {
    this.chrLo = r.u8();
    this.chrHi = r.u8();
  }
}
