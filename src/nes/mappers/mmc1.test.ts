import { describe, expect, it } from "vitest";

import type { NesRom } from "../cartridge/rom.js";
import { Mmc1Mapper } from "./mmc1.js";

/** Build a ROM whose PRG/CHR banks are self-identifying: the first byte of each
 *  16 KiB PRG bank is its index; the first byte of each 4 KiB CHR bank is
 *  0x80 | index. */
function makeRom(prgBanks: number, chrBanks: number): NesRom {
  const prgRom = new Uint8Array(prgBanks * 0x4000);
  for (let b = 0; b < prgBanks; b++) prgRom[b * 0x4000] = b;
  const chrRom = new Uint8Array(chrBanks * 0x1000);
  for (let b = 0; b < chrBanks; b++) chrRom[b * 0x1000] = 0x80 | b;
  return {
    prgRom,
    chrRom,
    usesChrRam: false,
    chrRamSize: 0,
    prgRamSize: 0x2000,
    prgNvramSize: 0,
    mapper: 1,
    submapper: 0,
    mirroring: "horizontal",
    battery: false,
    region: "ntsc",
    nes2: false
  };
}

/** Serial-load a 5-bit value into the register selected by `addr` (LSB first). */
function load(m: Mmc1Mapper, addr: number, value: number): void {
  for (let i = 0; i < 5; i++) m.prgWrite(addr, (value >> i) & 1);
}

const REG_CONTROL = 0x8000;
const REG_CHR0 = 0xa000;
const REG_CHR1 = 0xc000;
const REG_PRG = 0xe000;

describe("Mmc1Mapper", () => {
  it("powers up in PRG mode 3: last bank fixed at $C000, switchable $8000", () => {
    const m = new Mmc1Mapper(makeRom(8, 1));
    expect(m.prgRead(0xc000)).toBe(7); // last bank
    expect(m.prgRead(0x8000)).toBe(0); // prgBank defaults to 0
    load(m, REG_PRG, 5);
    expect(m.prgRead(0x8000)).toBe(5);
    expect(m.prgRead(0xc000)).toBe(7); // still fixed
  });

  it("PRG mode 2 fixes the first bank at $8000 and switches $C000", () => {
    const m = new Mmc1Mapper(makeRom(8, 1));
    load(m, REG_CONTROL, (2 << 2) | 3); // PRG mode 2, horizontal mirroring
    load(m, REG_PRG, 5);
    expect(m.prgRead(0x8000)).toBe(0); // fixed first
    expect(m.prgRead(0xc000)).toBe(5); // switchable
  });

  it("PRG 32 KiB mode maps a double bank, ignoring the low bit", () => {
    const m = new Mmc1Mapper(makeRom(8, 1));
    load(m, REG_CONTROL, (0 << 2) | 3); // 32 KiB mode
    load(m, REG_PRG, 5); // low bit ignored → 32 KiB bank starts at 4
    expect(m.prgRead(0x8000)).toBe(4);
    expect(m.prgRead(0xc000)).toBe(5);
  });

  it("switches CHR as one 8 KiB bank or two 4 KiB banks", () => {
    const m = new Mmc1Mapper(makeRom(2, 8));
    // 8 KiB mode (control bit 4 clear): low bit of CHR bank 0 ignored.
    load(m, REG_CONTROL, 3);
    load(m, REG_CHR0, 2);
    expect(m.chrRead(0x0000)).toBe(0x82);
    expect(m.chrRead(0x1000)).toBe(0x83);
    // 4 KiB mode (control bit 4 set): independent banks.
    load(m, REG_CONTROL, 0x10 | 3);
    load(m, REG_CHR0, 1);
    load(m, REG_CHR1, 3);
    expect(m.chrRead(0x0000)).toBe(0x81);
    expect(m.chrRead(0x1000)).toBe(0x83);
  });

  it("control bits 0-1 select the mirroring mode", () => {
    const m = new Mmc1Mapper(makeRom(2, 1));
    load(m, REG_CONTROL, 0);
    expect(m.mirroring()).toBe("single-lower");
    load(m, REG_CONTROL, 1);
    expect(m.mirroring()).toBe("single-upper");
    load(m, REG_CONTROL, 2);
    expect(m.mirroring()).toBe("vertical");
    load(m, REG_CONTROL, 3);
    expect(m.mirroring()).toBe("horizontal");
  });

  it("SUROM (512 KiB) takes PRG A18 from CHR bank 0 bit 4", () => {
    const m = new Mmc1Mapper(makeRom(32, 1)); // 512 KiB → SUROM
    load(m, REG_PRG, 3);
    // Page 0 (CHR0 bit 4 clear): switchable bank 3, fixed = last bank of page 0.
    expect(m.prgRead(0x8000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(15);
    // CHR bank 0 bit 4 selects the upper 256 KiB page for both banks.
    load(m, REG_CHR0, 0x10);
    expect(m.prgRead(0x8000)).toBe(0x10 | 3); // bank 19
    expect(m.prgRead(0xc000)).toBe(0x10 | 15); // fixed = last bank of page 1 (31)
  });

  it("ordinary carts (≤256 KiB) ignore CHR bank 0 bit 4 for PRG banking", () => {
    const m = new Mmc1Mapper(makeRom(8, 8)); // 128 KiB → not SUROM
    load(m, REG_PRG, 3); // power-on PRG mode 3: switchable $8000, fixed $C000
    load(m, REG_CHR0, 0x10); // A18 on SUROM; here it must not move PRG
    expect(m.prgRead(0x8000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(7); // last physical bank, unchanged
  });

  it("ignores a register write on the CPU cycle right after another (RMW quirk)", () => {
    const m = new Mmc1Mapper(makeRom(8, 1));
    // Model an INC on a register: it writes the old value then the new value on
    // back-to-back cycles. The old value (bit 7 set) resets the shift register;
    // the new value lands one cycle later and must be ignored, not shift a bit.
    m.tick(2);
    m.prgWrite(REG_PRG, 0x80); // reset (first write)
    m.tick(1);
    m.prgWrite(REG_PRG, 0x00); // consecutive cycle → ignored
    // The shift register is cleanly reset, so a normal 5-write load of 5 commits
    // to bank 5. If the stray write had shifted a bit in, this would be off-by-one.
    m.tick(2);
    load(m, REG_PRG, 5);
    expect(m.prgRead(0x8000)).toBe(5);
  });

  it("a write with bit 7 set resets the shift register and forces PRG mode 3", () => {
    const m = new Mmc1Mapper(makeRom(8, 1));
    load(m, REG_CONTROL, 0); // PRG mode 0 (32 KiB)
    m.prgWrite(0x8000, 0x80); // reset → control |= 0x0C (mode 3)
    expect(m.prgRead(0xc000)).toBe(7); // last bank fixed again

    // A partial (interrupted) sequence must not commit until 5 fresh bits land.
    m.prgWrite(REG_PRG, 1);
    m.prgWrite(REG_PRG, 1);
    m.prgWrite(0x8000, 0x80); // reset mid-sequence
    load(m, REG_PRG, 3);
    expect(m.prgRead(0x8000)).toBe(3);
  });
});
