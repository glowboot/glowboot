import { describe, expect, it } from "vitest";

import { Cartridge } from "./cartridge.js";
import { parseNesRom } from "./rom.js";

/** Build a minimal iNES image: 16-byte header + prgBanks*16K + chrBanks*8K.
 *  PRG bytes are filled with 0xA5 and CHR with 0x5A so reads are recognizable.
 *  Each 16 KiB PRG bank and each 8 KiB CHR bank also gets a leading marker byte
 *  equal to its index, so bank routing is observable. */
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
  for (let b = 0; b < opts.prgBanks; b++) prg[b * 16 * 1024] = b;
  const chr = new Uint8Array(opts.chrBanks * 8 * 1024).fill(0x5a);
  for (let b = 0; b < opts.chrBanks; b++) chr[b * 8 * 1024] = 0x80 | b;
  const out = new Uint8Array(header.length + prg.length + chr.length);
  out.set(header, 0);
  out.set(prg, header.length);
  out.set(chr, header.length + prg.length);
  return out;
}

/** A Cartridge built straight from an iNES image. */
function cart(opts: Parameters<typeof ines>[0]): Cartridge {
  return new Cartridge(parseNesRom(ines(opts)));
}

// iNES flags6 bits: 0x01 vertical, 0x02 battery, 0x08 four-screen.
// Mapper 0 (NROM) is flags6/flags7 high nibbles both 0.
// Mapper 7 (AxROM) is flags6 high nibble 7 → flags6 |= 0x70.
const AXROM_FLAGS6 = 0x70;

describe("Cartridge — nametable mirroring", () => {
  // Each two-screen layout maps the four logical nametables ($2000/$2400/
  // $2800/$2C00) onto two physical 1 KiB VRAM banks; writing a logical table
  // and reading its mirror partner proves which physical bank it landed in.
  it("horizontal mirroring: $2000≡$2400, $2800≡$2C00", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 /* flags6 high=0, H/V bit=0 */ });
    expect(c.rom.mirroring).toBe("horizontal");

    c.ppuWrite(0x2000, 0x11);
    c.ppuWrite(0x2800, 0x22);
    // $2400 mirrors $2000 (top bank), $2C00 mirrors $2800 (bottom bank).
    expect(c.ppuRead(0x2400)).toBe(0x11);
    expect(c.ppuRead(0x2c00)).toBe(0x22);
    // The two banks are distinct.
    expect(c.ppuRead(0x2000)).toBe(0x11);
    expect(c.ppuRead(0x2800)).toBe(0x22);
  });

  it("vertical mirroring: $2000≡$2800, $2400≡$2C00", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1, flags6: 0x01 });
    expect(c.rom.mirroring).toBe("vertical");

    c.ppuWrite(0x2000, 0x33);
    c.ppuWrite(0x2400, 0x44);
    // Vertical: tables 0/2 share bank 0, tables 1/3 share bank 1.
    expect(c.ppuRead(0x2800)).toBe(0x33);
    expect(c.ppuRead(0x2c00)).toBe(0x44);
    expect(c.ppuRead(0x2000)).toBe(0x33);
    expect(c.ppuRead(0x2400)).toBe(0x44);
  });

  it("four-screen mirroring: four distinct nametables", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1, flags6: 0x08 });
    expect(c.rom.mirroring).toBe("four-screen");

    c.ppuWrite(0x2000, 0xa0);
    c.ppuWrite(0x2400, 0xa1);
    c.ppuWrite(0x2800, 0xa2);
    c.ppuWrite(0x2c00, 0xa3);
    expect(c.ppuRead(0x2000)).toBe(0xa0);
    expect(c.ppuRead(0x2400)).toBe(0xa1);
    expect(c.ppuRead(0x2800)).toBe(0xa2);
    expect(c.ppuRead(0x2c00)).toBe(0xa3);
  });

  it("single-lower mirroring: all four tables share bank 0 (AxROM)", () => {
    // Mapper 7 powers up in single-lower and switches via $8000 bit 4.
    const c = cart({ prgBanks: 2, chrBanks: 0, flags6: AXROM_FLAGS6 });
    c.cpuWrite(0x8000, 0x00); // bit 4 clear → single-lower

    c.ppuWrite(0x2000, 0x55);
    // Every logical table aliases the same physical bank.
    expect(c.ppuRead(0x2400)).toBe(0x55);
    expect(c.ppuRead(0x2800)).toBe(0x55);
    expect(c.ppuRead(0x2c00)).toBe(0x55);
  });

  it("single-upper mirroring: all four tables share bank 1 (AxROM)", () => {
    const c = cart({ prgBanks: 2, chrBanks: 0, flags6: AXROM_FLAGS6 });
    c.cpuWrite(0x8000, 0x10); // bit 4 set → single-upper

    c.ppuWrite(0x2c00, 0x66);
    expect(c.ppuRead(0x2000)).toBe(0x66);
    expect(c.ppuRead(0x2400)).toBe(0x66);
    expect(c.ppuRead(0x2800)).toBe(0x66);
  });

  it("single-lower and single-upper use different physical banks", () => {
    const c = cart({ prgBanks: 2, chrBanks: 0, flags6: AXROM_FLAGS6 });
    c.cpuWrite(0x8000, 0x00); // single-lower (bank 0)
    c.ppuWrite(0x2000, 0x77);
    c.cpuWrite(0x8000, 0x10); // single-upper (bank 1)
    c.ppuWrite(0x2000, 0x88);
    // Bank 1 now holds 0x88; switching back exposes bank 0's untouched 0x77.
    expect(c.ppuRead(0x2000)).toBe(0x88);
    c.cpuWrite(0x8000, 0x00);
    expect(c.ppuRead(0x2000)).toBe(0x77);
  });

  it("preserves the low 10 bits of the address within a nametable", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 }); // horizontal
    c.ppuWrite(0x2000, 0x01);
    c.ppuWrite(0x23ff, 0x02); // last byte of table 0
    expect(c.ppuRead(0x2000)).toBe(0x01);
    expect(c.ppuRead(0x23ff)).toBe(0x02);
    // Distinct offsets within the same bank don't collide.
    expect(c.ppuRead(0x2000)).not.toBe(c.ppuRead(0x23ff));
  });
});

describe("Cartridge — $3000-$3EFF mirror fold", () => {
  it("$3000-$3EFF reads/writes alias $2000-$2EFF", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 }); // horizontal
    c.ppuWrite(0x2000, 0x12);
    expect(c.ppuRead(0x3000)).toBe(0x12); // $3000 folds to $2000

    c.ppuWrite(0x3456, 0x34);
    expect(c.ppuRead(0x2456)).toBe(0x34); // write via the mirror is visible at $2xxx

    c.ppuWrite(0x3eff, 0x9a);
    expect(c.ppuRead(0x2eff)).toBe(0x9a);
  });

  it("$3xxx mirroring honors the cart's nametable arrangement", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1, flags6: 0x01 }); // vertical
    c.ppuWrite(0x3000, 0xde);
    // Vertical: $3000≈$2000≡$2800.
    expect(c.ppuRead(0x2800)).toBe(0xde);
  });

  it("$4000+ folds back into the $0000-$3FFF space", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 });
    c.ppuWrite(0x2000, 0x7e);
    // addr &= 0x3FFF, so $6000 → $2000.
    expect(c.ppuRead(0x6000)).toBe(0x7e);
  });
});

describe("Cartridge — CHR routing", () => {
  it("routes $0000-$1FFF reads to the mapper's CHR ROM", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 });
    expect(c.rom.usesChrRam).toBe(false);
    expect(c.ppuRead(0x0000)).toBe(0x80); // CHR bank-0 marker
    expect(c.ppuRead(0x0001)).toBe(0x5a); // CHR fill byte
  });

  it("CHR ROM is not writable (writes are dropped)", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 });
    c.ppuWrite(0x0001, 0xff);
    expect(c.ppuRead(0x0001)).toBe(0x5a); // unchanged
  });

  it("CHR RAM (chrBanks=0) is writable through $0000-$1FFF", () => {
    const c = cart({ prgBanks: 1, chrBanks: 0 });
    expect(c.rom.usesChrRam).toBe(true);
    c.ppuWrite(0x0abc, 0x42);
    expect(c.ppuRead(0x0abc)).toBe(0x42);
    expect(c.ppuRead(0x0000)).toBe(0); // CHR RAM powers up zeroed
  });

  it("does not route $0000-$1FFF through the nametable VRAM", () => {
    const c = cart({ prgBanks: 1, chrBanks: 0 });
    c.ppuWrite(0x0000, 0x11); // CHR RAM
    c.ppuWrite(0x2000, 0x22); // nametable
    expect(c.ppuRead(0x0000)).toBe(0x11);
    expect(c.ppuRead(0x2000)).toBe(0x22);
  });
});

describe("Cartridge — PRG-RAM ($6000-$7FFF)", () => {
  it("reads and writes the work-RAM window", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 });
    c.cpuWrite(0x6000, 0xab);
    c.cpuWrite(0x7fff, 0xcd);
    expect(c.cpuRead(0x6000)).toBe(0xab);
    expect(c.cpuRead(0x7fff)).toBe(0xcd);
  });

  it("powers up zeroed and is independent of PRG ROM", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 });
    expect(c.cpuRead(0x6000)).toBe(0); // PRG-RAM, not the 0xA5 ROM fill
    expect(c.cpuRead(0x8000)).toBe(0); // PRG bank-0 marker
    expect(c.cpuRead(0x8001)).toBe(0xa5); // PRG ROM fill
  });

  it("the work-RAM window does not bleed into adjacent regions", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 });
    c.cpuWrite(0x6000, 0x99);
    // $5FFF is below the window (open-bus low region) and $8000 is PRG ROM.
    expect(c.cpuRead(0x5fff)).toBe(0);
    expect(c.cpuRead(0x8000)).not.toBe(0x99);
  });
});

describe("Cartridge — battery accessors", () => {
  it("non-battery NROM: hasBattery=false, batteryRam=null", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 /* battery bit clear */ });
    expect(c.hasBattery).toBe(false);
    expect(c.batteryRam).toBeNull();
  });

  it("non-battery cart ignores loadBatteryRam", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1 });
    c.loadBatteryRam(new Uint8Array([1, 2, 3, 4]));
    expect(c.cpuRead(0x6000)).toBe(0); // PRG-RAM untouched
  });

  it("battery NROM: hasBattery=true and batteryRam mirrors PRG-RAM writes", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1, flags6: 0x02 /* battery */ });
    expect(c.hasBattery).toBe(true);
    const bram = c.batteryRam;
    expect(bram).not.toBeNull();
    // iNES battery RAM is the whole 8 KiB work-RAM bank.
    expect(bram!.length).toBe(8 * 1024);

    // batteryRam is a live view into PRG-RAM: a CPU write shows through it.
    c.cpuWrite(0x6000, 0x5e);
    expect(c.batteryRam![0]).toBe(0x5e);
  });

  it("loadBatteryRam restores a save into the work-RAM window", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1, flags6: 0x02 });
    const save = new Uint8Array(8 * 1024).fill(0x7c);
    save[0] = 0xa1;
    c.loadBatteryRam(save);
    expect(c.cpuRead(0x6000)).toBe(0xa1);
    expect(c.cpuRead(0x6001)).toBe(0x7c);
    expect(c.batteryRam![0]).toBe(0xa1);
  });

  it("loadBatteryRam clamps an oversized save to the work-RAM length", () => {
    const c = cart({ prgBanks: 1, chrBanks: 1, flags6: 0x02 });
    const tooBig = new Uint8Array(64 * 1024).fill(0x3f); // larger than 8 KiB
    expect(() => c.loadBatteryRam(tooBig)).not.toThrow();
    expect(c.cpuRead(0x6000)).toBe(0x3f);
  });
});
