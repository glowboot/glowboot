/**
 * Simple Jaleco bank-latch mappers (72 / 86 / 92 / 140). Each switches a whole
 * PRG window and an 8 KiB CHR bank from a single latch; the ADPCM voice channel
 * some of these boards carry (JF-13/JF-17) is not emulated.
 *
 *   86  JF-13  — $6000-$6FFF latch: PRG 32 KiB + 8 KiB CHR. Moero!! Pro Yakyuu.
 *   140 JF-11/14 — $6000-$7FFF latch: PRG 32 KiB + 8 KiB CHR. Bio Senshi Dan.
 *   72  JF-17  — $8000-$FFFF: bit 7 sets the $8000 16 KiB bank, bit 6 the 8 KiB
 *                CHR bank; $C000 fixed last. Pinball Quest, Moero!! Juudou.
 *   92  JF-19/21 — like 72 but the switchable 16 KiB window is $C000 ($8000
 *                fixed first). Moero!! Pro Soccer, Pro Yakyuu '88.
 *
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_072 / _086 / _092 / _140.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

abstract class JalecoBase implements Mapper {
  protected readonly prg: Uint8Array;
  protected readonly chr: Uint8Array;
  protected readonly chrWritable: boolean;
  protected readonly mirror: Mirroring;
  protected prgBank = 0; // 16 KiB granularity (low window)
  protected chrBank = 0; // 8 KiB

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

  /** Resolve the 16 KiB PRG bank for the $8000 and $C000 halves. */
  protected abstract prgBank16(high: boolean): number;

  prgRead(addr: number): number {
    const bank = this.prgBank16((addr & 0x4000) !== 0);
    const banks = Math.max(1, this.prg.length / 0x4000);
    return this.prg[((bank % banks) * 0x4000 + (addr & 0x3fff)) % this.prg.length]!;
  }
  abstract prgWrite(addr: number, value: number): void;

  chrRead(addr: number): number {
    const banks = Math.max(1, this.chr.length / 0x2000);
    return this.chr[((this.chrBank % banks) * 0x2000 + (addr & 0x1fff)) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[addr & 0x1fff] = value;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgBank);
    w.u8(this.chrBank);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    this.chrBank = r.u8();
    if (this.chrWritable) r.bytes(this.chr);
  }
}

/** Mappers 86 (JF-13) and 140 (JF-11/14) — a $6000-$7FFF latch selecting a
 *  32 KiB PRG bank and an 8 KiB CHR bank. `prgBank` is stored in 16 KiB units. */
export class Jaleco140Mapper extends JalecoBase {
  protected prgBank16(high: boolean): number {
    return this.prgBank + (high ? 1 : 0);
  }
  prgWrite(): void {
    /* registers are below PRG, via lowWrite */
  }
  lowWrite(_addr: number, value: number): void {
    // 140: PRG bits 4-5 (32 KiB), CHR bits 0-3.
    this.prgBank = ((value >> 4) & 3) * 2;
    this.chrBank = value & 0x0f;
  }
}

/** Mapper 86 (JF-13) — same $6000 latch but the CHR bank is bits 0-1 + bit 6. */
export class Jaleco86Mapper extends Jaleco140Mapper {
  override lowWrite(addr: number, value: number): void {
    if (addr >= 0x7000) return; // only $6000-$6FFF is the bank latch (rest is sample)
    this.prgBank = ((value >> 4) & 3) * 2;
    this.chrBank = (value & 3) | ((value >> 4) & 4);
  }
}

/** Mapper 72 (JF-17) — $8000-$FFFF: bit 7 latches the $8000 16 KiB bank, bit 6
 *  the 8 KiB CHR bank; $C000 is fixed to the last 16 KiB. */
export class Jaleco72Mapper extends JalecoBase {
  protected prgBank16(high: boolean): number {
    return high ? Math.max(1, this.prg.length / 0x4000) - 1 : this.prgBank;
  }
  prgWrite(_addr: number, value: number): void {
    if (value & 0x80) this.prgBank = value & 0x0f;
    if (value & 0x40) this.chrBank = value & 0x0f;
  }
}

/** Mapper 92 (JF-19/21) — like 72 but the switchable 16 KiB window is $C000 and
 *  $8000 is fixed to the first bank. */
export class Jaleco92Mapper extends JalecoBase {
  protected prgBank16(high: boolean): number {
    return high ? this.prgBank : 0;
  }
  prgWrite(_addr: number, value: number): void {
    if (value & 0x80) this.prgBank = value & 0x0f;
    if (value & 0x40) this.chrBank = value & 0x0f;
  }
}
