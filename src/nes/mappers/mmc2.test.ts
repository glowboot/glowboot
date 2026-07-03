import { describe, expect, it } from "vitest";

import type { NesRom } from "../cartridge/rom.js";
import { Mmc2Mapper, Mmc4Mapper } from "./mmc2.js";

/** PRG tagged per 8 KiB bank (byte 0 = index), CHR per 4 KiB bank (0x80|index). */
function makeRom(prg8k: number, chr4k: number): NesRom {
  const prgRom = new Uint8Array(prg8k * 0x2000);
  for (let b = 0; b < prg8k; b++) prgRom[b * 0x2000] = b;
  const chrRom = new Uint8Array(chr4k * 0x1000);
  for (let b = 0; b < chr4k; b++) chrRom[b * 0x1000] = (0x80 | b) & 0xff;
  return {
    prgRom,
    chrRom,
    usesChrRam: false,
    chrRamSize: 0,
    prgRamSize: 0x2000,
    prgNvramSize: 0,
    mapper: 9,
    submapper: 0,
    mirroring: "vertical",
    battery: false,
    region: "ntsc",
    nes2: false
  };
}

describe("Mmc2Mapper", () => {
  it("switches $8000 (8 KiB) and fixes the last 3 banks above", () => {
    const m = new Mmc2Mapper(makeRom(8, 4));
    m.prgWrite(0xa000, 3); // $8000 → bank 3
    expect(m.prgRead(0x8000)).toBe(3);
    expect(m.prgRead(0xa000)).toBe(5); // 8-3
    expect(m.prgRead(0xc000)).toBe(6); // 8-2
    expect(m.prgRead(0xe000)).toBe(7); // 8-1
  });

  it("selects CHR via the $0000-half latch, which flips on tile fetches", () => {
    const m = new Mmc2Mapper(makeRom(8, 4));
    m.prgWrite(0xb000, 1); // FD bank for $0000 → 1
    m.prgWrite(0xc000, 2); // FE bank for $0000 → 2
    // Fetch $0FD8 sets latch0 = FD (after returning this byte); next read uses it.
    m.chrRead(0x0fd8);
    expect(m.chrRead(0x0000)).toBe(0x81); // bank 1
    m.chrRead(0x0fe8); // latch0 = FE
    expect(m.chrRead(0x0000)).toBe(0x82); // bank 2
  });

  it("$F000 sets mirroring", () => {
    const m = new Mmc2Mapper(makeRom(8, 4));
    m.prgWrite(0xf000, 0);
    expect(m.mirroring()).toBe("vertical");
    m.prgWrite(0xf000, 1);
    expect(m.mirroring()).toBe("horizontal");
  });
});

describe("Mmc4Mapper", () => {
  // 8 PRG 8 KiB banks = 4 PRG 16 KiB banks. makeRom tags each 8 KiB bank, so a
  // 16 KiB bank N starts at the 8 KiB-bank index 2N (16K bank 0 → tag 0, bank 1
  // → tag 2, bank 2 → tag 4, bank 3 → tag 6).
  it("switches $8000 (16 KiB) and fixes the last 16 KiB above $C000", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    m.prgWrite(0xa000, 1); // $8000 → 16K bank 1
    expect(m.prgRead(0x8000)).toBe(2); // lower 8K of 16K bank 1 → tag 2
    expect(m.prgRead(0xa000)).toBe(3); // upper 8K of the same 16K bank → tag 3
    // $C000-$FFFF is the fixed last 16K bank (banks16 - 1 = 3): lower 8K → tag
    // 6, upper 8K → tag 7.
    expect(m.prgRead(0xc000)).toBe(6);
    expect(m.prgRead(0xe000)).toBe(7); // same fixed 16K window, upper half
  });

  it("selects the switchable 16 KiB window by the $A000 register", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    m.prgWrite(0xa000, 0); // 16K bank 0 → tag 0
    expect(m.prgRead(0x8000)).toBe(0);
    m.prgWrite(0xa000, 2); // 16K bank 2 → tag 4
    expect(m.prgRead(0x8000)).toBe(4);
    // The fixed upper window never moves regardless of the $A000 selection.
    expect(m.prgRead(0xc000)).toBe(6);
  });

  it("masks the $A000 register to 4 bits", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    // value & 0x0f keeps only the low nibble; 0x12 → 2 → 16K bank 2 → tag 4.
    m.prgWrite(0xa000, 0x12);
    expect(m.prgRead(0x8000)).toBe(4);
  });

  it("selects CHR via the $0000-half latch, which flips on tile fetches", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    m.prgWrite(0xb000, 1); // FD bank for $0000 → 1
    m.prgWrite(0xc000, 2); // FE bank for $0000 → 2
    // Fetch $0FD8 sets latch0 = FD (after returning this byte); next read uses it.
    m.chrRead(0x0fd8);
    expect(m.chrRead(0x0000)).toBe(0x81); // bank 1
    m.chrRead(0x0fe8); // latch0 = FE
    expect(m.chrRead(0x0000)).toBe(0x82); // bank 2
  });

  it("selects CHR via the $1000-half latch independently", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    m.prgWrite(0xd000, 1); // FD bank for $1000 → 1
    m.prgWrite(0xe000, 3); // FE bank for $1000 → 3
    // latch1 defaults to 1 (FE) → bank 3.
    expect(m.chrRead(0x1000)).toBe(0x83);
    m.chrRead(0x1fd8); // latch1 = FD
    expect(m.chrRead(0x1000)).toBe(0x81); // bank 1
    m.chrRead(0x1fe8); // latch1 = FE
    expect(m.chrRead(0x1000)).toBe(0x83); // bank 3
  });

  it("flips the latch only inside the $FD8-$FDF / $FE8-$FEF tile ranges", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    m.prgWrite(0xb000, 1); // FD bank → 1
    m.prgWrite(0xc000, 2); // FE bank → 2
    m.chrRead(0x0fd8); // latch0 = FD
    expect(m.chrRead(0x0000)).toBe(0x81);
    // A fetch outside the latch ranges must not change the latch.
    m.chrRead(0x0000);
    m.chrRead(0x0fd0);
    m.chrRead(0x0fe0);
    expect(m.chrRead(0x0000)).toBe(0x81); // still FD
  });

  it("applies the latch flip only to fetches after the trigger fetch", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    m.prgWrite(0xb000, 1); // FD bank → 1
    m.prgWrite(0xc000, 2); // FE bank → 2
    // latch0 defaults to FE (bank 2). The $0FD8 fetch reads from sub-bank offset
    // $FD8 (untagged → 0) and only then switches the latch to FD, so the
    // follow-up $0000 read is the first to observe the flipped latch.
    expect(m.chrRead(0x0fd8)).toBe(0);
    expect(m.chrRead(0x0000)).toBe(0x81);
  });

  it("$F000 sets mirroring", () => {
    const m = new Mmc4Mapper(makeRom(8, 4));
    m.prgWrite(0xf000, 0);
    expect(m.mirroring()).toBe("vertical");
    m.prgWrite(0xf000, 1);
    expect(m.mirroring()).toBe("horizontal");
  });
});
