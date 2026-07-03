/**
 * MMC3 clones — boards that reuse the MMC3 bank registers and A12 scanline IRQ
 * but tweak one piece of the banking. Each subclasses {@link Mmc3Mapper} and
 * overrides one or two protected hooks (PRG/CHR resolution, register decode, or
 * nametable routing).
 *
 *   206 Namco 108    — the MMC3 ancestor: same $8000/$8001 banking, but no mode
 *                      bits, no mirroring register, and no IRQ.
 *   119 TQROM        — CHR bank bit 6 selects 8 KiB CHR-RAM vs CHR-ROM.
 *   189              — a single 32 KiB PRG bank selected at $4120-$7FFF; the
 *                      MMC3 PRG registers are ignored, CHR/IRQ are standard.
 *   245 Waixing-A    — an extra PRG outer bank from R0 bit 1 (512 KiB blocks).
 *
 * References: https://www.nesdev.org/wiki/INES_Mapper_206 / _119 / _189 / _245.
 */

import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import { Mmc3Mapper } from "./mmc3.js";

const CHR_BANK = 0x400; // 1 KiB

/** Mapper 206 (Namco 108 / DxROM / Tengen MIMIC-1) — Gauntlet, Dragon Spirit,
 *  Karnov, Pac-Mania, dozens of Namco titles. MMC3 banking with the command
 *  limited to its low 3 bits (no PRG/CHR mode); $A000-$FFFF is unconnected, so
 *  mirroring stays fixed from the header and there is no IRQ. */
export class Mapper206 extends Mmc3Mapper {
  protected override writeRegister(addr: number, value: number): void {
    if (addr >= 0xa000) return; // no mirroring / IRQ / PRG-RAM-protect registers
    if ((addr & 1) === 0)
      this.bankSelect = value & 0x07; // 3-bit command only
    else this.regs[this.bankSelect & 0x07] = value;
  }
}

/** Mapper 119 (TQROM) — Pin-Bot, High Speed. */
export class TqromMapper extends Mmc3Mapper {
  private readonly chrRam = new Uint8Array(0x2000); // 8 KiB

  protected override fetchChr(bank: number, offset: number): number {
    if (bank & 0x40) return this.chrRam[((bank & 0x07) * CHR_BANK + offset) & 0x1fff]!;
    return this.chr[((bank & 0x3f) * CHR_BANK + offset) % this.chr.length]!;
  }
  protected override storeChr(bank: number, offset: number, value: number): void {
    if (bank & 0x40) this.chrRam[((bank & 0x07) * CHR_BANK + offset) & 0x1fff] = value;
  }

  override serialize(w: NesStateWriter): void {
    super.serialize(w);
    w.bytes(this.chrRam);
  }
  override deserialize(r: NesStateReader): void {
    super.deserialize(r);
    r.bytes(this.chrRam);
  }
}

/** Mapper 189 — Master Fighter II/III, Thunder Warrior. */
export class Mapper189 extends Mmc3Mapper {
  private prg32 = 0;

  lowWrite(addr: number, value: number): void {
    if (addr >= 0x4120) this.prg32 = ((value >> 4) | value) & 0x0f; // 32 KiB select
  }
  protected override writeRegister(addr: number, value: number): void {
    if (addr < 0xa000 && (addr & 1) === 0) this.prg32 = ((value >> 4) | value) & 0x0f;
    super.writeRegister(addr, value);
  }
  protected override prgBank8k(region: number): number {
    return this.prg32 * 4 + region; // fixed 32 KiB window, MMC3 PRG regs ignored
  }

  override serialize(w: NesStateWriter): void {
    super.serialize(w);
    w.u8(this.prg32);
  }
  override deserialize(r: NesStateReader): void {
    super.deserialize(r);
    this.prg32 = r.u8();
  }
}

/** Mapper 245 (Waixing Type A) — Dragon Quest IV (zh), San Guo Zhi. */
export class Waixing245Mapper extends Mmc3Mapper {
  protected override prgBank8k(region: number): number {
    const outer = (this.regs[0]! & 0x02) << 5; // R0 bit 1 → 512 KiB PRG block
    return outer | super.prgBank8k(region);
  }
}

/** Mapper 118 (TxSROM / TLSROM) — Armadillo, Ys III, Alien Syndrome, NES Play
 *  Action Football. Standard MMC3, except the $A000 mirroring register is
 *  ignored: instead CIRAM A10 (which of the two nametables) is driven per
 *  quadrant by bit 7 of the CHR bank that maps it, giving a "diagonal"
 *  one-screen split the MMC3's fixed mirroring can't. */
export class TxSromMapper extends Mmc3Mapper {
  nametable(table: number): number {
    // CHR mode 0: the four 1 KiB banks R2-R5 map $1000-$1FFF, one per quadrant.
    // CHR mode 1 (halves swapped): the two 2 KiB banks R0/R1 cover it, each
    // spanning two quadrants. Bit 7 of the applicable register is CIRAM A10.
    const reg = this.bankSelect & 0x80 ? [0, 0, 1, 1][table]! : 2 + table;
    return (this.regs[reg]! >> 7) & 1;
  }
}
