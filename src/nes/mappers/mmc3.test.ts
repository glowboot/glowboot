import { describe, expect, it } from "vitest";

import type { NesRom } from "../cartridge/rom.js";
import { Mmc3Mapper } from "./mmc3.js";

/** PRG banks (8 KiB) and CHR banks (1 KiB) tagged with their index at offset 0. */
function makeRom(prg8k: number, chr1k: number): NesRom {
  const prgRom = new Uint8Array(prg8k * 0x2000);
  for (let b = 0; b < prg8k; b++) prgRom[b * 0x2000] = b;
  const chrRom = new Uint8Array(chr1k * 0x400);
  for (let b = 0; b < chr1k; b++) chrRom[b * 0x400] = b & 0xff;
  return {
    prgRom,
    chrRom,
    usesChrRam: false,
    chrRamSize: 0,
    prgRamSize: 0x2000,
    prgNvramSize: 0,
    mapper: 4,
    submapper: 0,
    mirroring: "horizontal",
    battery: false,
    region: "ntsc",
    nes2: false
  };
}

/** Select register `reg` (with PRG/CHR modes) and write its bank value. */
function bank(m: Mmc3Mapper, reg: number, value: number, prgMode = 0, chrMode = 0): void {
  m.prgWrite(0x8000, (chrMode << 7) | (prgMode << 6) | reg);
  m.prgWrite(0x8001, value);
}

describe("Mmc3Mapper", () => {
  it("PRG mode 0: R6/R7 at $8000/$A000, fixed penult/last at $C000/$E000", () => {
    const m = new Mmc3Mapper(makeRom(8, 8));
    bank(m, 6, 3, 0);
    bank(m, 7, 4, 0);
    expect(m.prgRead(0x8000)).toBe(3);
    expect(m.prgRead(0xa000)).toBe(4);
    expect(m.prgRead(0xc000)).toBe(6); // penult of 8
    expect(m.prgRead(0xe000)).toBe(7); // last
  });

  it("PRG mode 1: fixed penult at $8000, R6 at $C000", () => {
    const m = new Mmc3Mapper(makeRom(8, 8));
    bank(m, 6, 3, 1);
    expect(m.prgRead(0x8000)).toBe(6); // penult
    expect(m.prgRead(0xc000)).toBe(3); // R6
  });

  it("CHR: 2 KiB banks low, 1 KiB banks high; CHR mode 1 swaps", () => {
    const m = new Mmc3Mapper(makeRom(8, 8));
    bank(m, 0, 2, 0, 0); // R0 → 2 KiB bank at $0000
    bank(m, 2, 5, 0, 0); // R2 → 1 KiB bank at $1000
    expect(m.chrRead(0x0000)).toBe(2);
    expect(m.chrRead(0x1000)).toBe(5);
    bank(m, 0, 2, 0, 1); // CHR mode 1: halves swap
    expect(m.chrRead(0x1000)).toBe(2);
  });

  it("$A000 selects mirroring", () => {
    const m = new Mmc3Mapper(makeRom(8, 8));
    m.prgWrite(0xa000, 0);
    expect(m.mirroring()).toBe("vertical");
    m.prgWrite(0xa000, 1);
    expect(m.mirroring()).toBe("horizontal");
  });

  it("scanline IRQ counts down from the latch and is acknowledged via $E000", () => {
    const m = new Mmc3Mapper(makeRom(8, 8));
    m.prgWrite(0xc000, 3); // latch
    m.prgWrite(0xc001, 0); // reload on next clock
    m.prgWrite(0xe001, 0); // enable
    m.clockIrq(); // reload → 3
    m.clockIrq(); // 2
    m.clockIrq(); // 1
    expect(m.irqState()).toBe(false);
    m.clockIrq(); // 0 → IRQ
    expect(m.irqState()).toBe(true);
    m.prgWrite(0xe000, 0); // disable + acknowledge
    expect(m.irqState()).toBe(false);
  });
});
