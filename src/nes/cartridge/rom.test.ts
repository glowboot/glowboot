import { describe, expect, it } from "vitest";

import { parseNesRom } from "./rom.js";

/** Build a minimal iNES image: 16-byte header + prgBanks*16K + chrBanks*8K. */
function ines(opts: {
  prgBanks: number;
  chrBanks: number;
  flags6?: number;
  flags7?: number;
  byte8?: number;
}): Uint8Array {
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a]);
  header[4] = opts.prgBanks;
  header[5] = opts.chrBanks;
  header[6] = opts.flags6 ?? 0;
  header[7] = opts.flags7 ?? 0;
  header[8] = opts.byte8 ?? 0;
  const prg = new Uint8Array(opts.prgBanks * 16 * 1024).fill(0xa5);
  const chr = new Uint8Array(opts.chrBanks * 8 * 1024).fill(0x5a);
  const out = new Uint8Array(header.length + prg.length + chr.length);
  out.set(header, 0);
  out.set(prg, header.length);
  out.set(chr, header.length + prg.length);
  return out;
}

describe("parseNesRom — iNES", () => {
  it("rejects a non-NES file", () => {
    expect(() => parseNesRom(new Uint8Array([1, 2, 3, 4]))).toThrow(/bad magic/);
  });

  it("parses NROM (mapper 0), horizontal mirroring, CHR ROM present", () => {
    const rom = parseNesRom(ines({ prgBanks: 2, chrBanks: 1 }));
    expect(rom.mapper).toBe(0);
    expect(rom.prgRom.length).toBe(2 * 16 * 1024);
    expect(rom.chrRom.length).toBe(8 * 1024);
    expect(rom.usesChrRam).toBe(false);
    expect(rom.mirroring).toBe("horizontal");
    expect(rom.battery).toBe(false);
    expect(rom.nes2).toBe(false);
    expect(rom.prgRom[0]).toBe(0xa5);
    expect(rom.chrRom[0]).toBe(0x5a);
  });

  it("reads the mapper number from both nibbles (flags6 high + flags7 high)", () => {
    // mapper 4 (MMC3): low nibble in flags6 bits 4-7, high nibble in flags7.
    const rom = parseNesRom(ines({ prgBanks: 1, chrBanks: 1, flags6: 0x40, flags7: 0x00 }));
    expect(rom.mapper).toBe(4);
    const rom66 = parseNesRom(ines({ prgBanks: 1, chrBanks: 1, flags6: 0x20, flags7: 0x40 }));
    expect(rom66.mapper).toBe(0x42);
  });

  it('ignores flags7 corrupted by a "DiskDude!" header (uses only flags6)', () => {
    // Real mapper 2 (UNROM), flags6 high nibble = 2. The "DiskDude!" writer
    // clobbered bytes 7-15 with ASCII, making flags7 = 'D' ($44) → a naive
    // parser would read mapper 0x42 (66). The trailing non-zero bytes flag the
    // header as archaic, so flags7's nibble must be discarded.
    const data = ines({ prgBanks: 1, chrBanks: 1, flags6: 0x20 });
    data.set(
      "DiskDude!".split("").map((c) => c.charCodeAt(0)),
      7
    ); // bytes 7-15
    expect(parseNesRom(data).mapper).toBe(2);
  });

  it("vertical mirroring + battery from flags6", () => {
    const rom = parseNesRom(ines({ prgBanks: 1, chrBanks: 1, flags6: 0x01 | 0x02 }));
    expect(rom.mirroring).toBe("vertical");
    expect(rom.battery).toBe(true);
  });

  it("four-screen mirroring overrides the H/V bit", () => {
    const rom = parseNesRom(ines({ prgBanks: 1, chrBanks: 1, flags6: 0x08 | 0x01 }));
    expect(rom.mirroring).toBe("four-screen");
  });

  it("CHR ROM size 0 → CHR RAM (8 KiB default on iNES)", () => {
    const rom = parseNesRom(ines({ prgBanks: 1, chrBanks: 0 }));
    expect(rom.usesChrRam).toBe(true);
    expect(rom.chrRom.length).toBe(0);
    expect(rom.chrRamSize).toBe(8 * 1024);
  });
});

describe("parseNesRom — NES 2.0", () => {
  it("detects NES 2.0 and reads the extended mapper + submapper", () => {
    const data = ines({ prgBanks: 1, chrBanks: 1, flags6: 0x10, flags7: 0x08 /* NES2.0 */ });
    data[8] = 0x21; // mapper high nibble = 1 (bits 8-11), submapper = 2
    const rom = parseNesRom(data);
    expect(rom.nes2).toBe(true);
    expect(rom.mapper).toBe(0x101); // (1<<8) | flags7-high(0) | flags6-high(1)
    expect(rom.submapper).toBe(2);
  });

  it("reads NES 2.0 explicit RAM/NVRAM shift sizes", () => {
    const data = ines({ prgBanks: 1, chrBanks: 1, flags7: 0x08 });
    data[10] = 0x70; // PRG RAM shift 0 → 0; PRG NVRAM shift 7 → 64<<7 = 8 KiB
    data[11] = 0x07; // CHR RAM shift 7 → 8 KiB
    const rom = parseNesRom(data);
    expect(rom.prgRamSize).toBe(0);
    expect(rom.prgNvramSize).toBe(8 * 1024);
    expect(rom.chrRamSize).toBe(8 * 1024);
  });
});
