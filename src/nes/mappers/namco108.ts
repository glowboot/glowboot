/**
 * Namco 108 variants (mappers 88 / 95 / 154 / 76), all built on the Namco 108
 * board ({@link Mapper206}): the same 3-bit command port at $8000/$8001 driving
 * two 2 KiB + four 1 KiB CHR banks and two 8 KiB PRG banks, with a small board
 * wiring difference each:
 *
 *   88  DxROM  — 1 KiB CHR banks come from the upper 64 KiB (CHR A16 forced).
 *               Dragon Spirit, Namco Classic.
 *   95  —       88 plus per-nametable mirroring from bit 5 of the 2 KiB banks.
 *               Dragon Buster.
 *   154 —       88 plus one-screen mirroring from $8000 bit 6. Devil Man,
 *               Family Circuit '91.
 *   76  Namco 109 — CHR is four 2 KiB banks (R2-R5) instead of the 2 KiB+1 KiB
 *               split. Digital Devil Story: Megami Tensei.
 *
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_088 / _095 / _154 / _076.
 */

import { Mapper206 } from "./mmc3-clones.js";

/** Mapper 88 (DxROM) — the 1 KiB CHR banks ($1000-$1FFF) select from the high
 *  64 KiB of CHR; the 2 KiB banks ($0000-$0FFF) from the low 64 KiB. */
export class Mapper88 extends Mapper206 {
  protected override chrBankFor(addr: number): number {
    const bank = super.chrBankFor(addr);
    return addr & 0x1000 ? bank | 0x40 : bank;
  }
}

/** Mapper 95 (Dragon Buster) — like 88, but bit 5 of the two 2 KiB CHR bank
 *  registers (R0/R1) drives CIRAM A10 for the two nametable halves. */
export class Mapper95 extends Mapper88 {
  nametable(table: number): number {
    return (this.regs[table < 2 ? 0 : 1]! >> 5) & 1;
  }
}

/** Mapper 154 (Devil Man) — like 88, plus one-screen mirroring from $8000
 *  bit 6 (0 = lower CIRAM page, 1 = upper). */
export class Mapper154 extends Mapper88 {
  protected override writeRegister(addr: number, value: number): void {
    if (addr < 0xa000 && (addr & 1) === 0) {
      this.mirror = value & 0x40 ? "single-upper" : "single-lower";
    }
    super.writeRegister(addr, value);
  }
}

/** Mapper 76 (Namco 109 / Namco 3433) — CHR is four 2 KiB banks (R2-R5) spanning
 *  PPU $0000-$1FFF; R0/R1 are unused. Megami Tensei. */
export class Mapper76 extends Mapper206 {
  protected override chrBankFor(addr: number): number {
    const region2k = (addr >> 11) & 3; // four 2 KiB windows
    return this.regs[2 + region2k]! * 2 + ((addr >> 10) & 1);
  }
}
