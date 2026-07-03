import { describe, expect, it } from "vitest";

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import { AxromMapper } from "./axrom.js";
import { Bandai74Mapper } from "./bandai74.js";
import { BnromMapper } from "./bnrom.js";
import { CamericaMapper } from "./camerica.js";
import { CnromMapper } from "./cnrom.js";
import { ColorDreamsMapper } from "./colordreams.js";
import { CpromMapper } from "./cprom.js";
import { GxromMapper } from "./gxrom.js";
import { Nina03Mapper, Nina113Mapper } from "./nina.js";
import { NromMapper } from "./nrom.js";
import { QuattroMapper } from "./quattro.js";
import { Sunsoft4Mapper } from "./sunsoft4.js";
import { UxromMapper } from "./uxrom.js";

function rom(opts: { prg: number; chrRom?: number; chrRam?: boolean; mapper: number; mirroring?: Mirroring }): NesRom {
  // Fill with 0xFF so a bus-conflict AND against a non-marker byte is a no-op;
  // the 16 KiB-aligned markers (bank index) sit at each bank's offset 0.
  const prgRom = new Uint8Array(opts.prg * 0x4000).fill(0xff);
  for (let b = 0; b < opts.prg; b++) prgRom[b * 0x4000] = b; // 16 KiB markers
  const chrRom = new Uint8Array((opts.chrRom ?? 0) * 0x2000);
  for (let b = 0; b < (opts.chrRom ?? 0); b++) chrRom[b * 0x2000] = 0x80 | b; // 8 KiB markers
  return {
    prgRom,
    chrRom,
    usesChrRam: opts.chrRam ?? false,
    chrRamSize: opts.chrRam ? 0x2000 : 0,
    prgRamSize: 0x2000,
    prgNvramSize: 0,
    mapper: opts.mapper,
    submapper: 0,
    mirroring: opts.mirroring ?? "vertical",
    battery: false,
    region: "ntsc",
    nes2: false
  };
}

describe("UxromMapper", () => {
  it("switches the $8000 bank and fixes the last bank at $C000", () => {
    const m = new UxromMapper(rom({ prg: 8, chrRam: true, mapper: 2 }));
    expect(m.prgRead(0xc000)).toBe(7); // last
    m.prgWrite(0x8000, 3);
    expect(m.prgRead(0x8000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(7); // still fixed
  });
  it("CHR RAM is writable", () => {
    const m = new UxromMapper(rom({ prg: 2, chrRam: true, mapper: 2 }));
    m.chrWrite(0x0123, 0x5a);
    expect(m.chrRead(0x0123)).toBe(0x5a);
  });
});

describe("CnromMapper", () => {
  it("switches the 8 KiB CHR bank; PRG is fixed", () => {
    const m = new CnromMapper(rom({ prg: 2, chrRom: 4, mapper: 3 }));
    expect(m.prgRead(0x8000)).toBe(0);
    m.prgWrite(0x8000, 2);
    expect(m.chrRead(0x0000)).toBe(0x82); // bank 2 marker
  });
});

describe("AxromMapper", () => {
  it("switches the 32 KiB PRG bank and single-screen mirroring", () => {
    const m = new AxromMapper(rom({ prg: 4, chrRam: true, mapper: 7 })); // 4×16 KiB = 2×32 KiB
    m.prgWrite(0x8000, 1);
    expect(m.prgRead(0x8000)).toBe(2); // 32 KiB bank 1 = 16 KiB bank 2
    expect(m.mirroring()).toBe("single-lower");
    m.prgWrite(0x8000, 0x10);
    expect(m.mirroring()).toBe("single-upper");
  });
});

describe("GxromMapper", () => {
  it("selects a 32 KiB PRG bank (bits 4-5) and 8 KiB CHR bank (bits 0-1)", () => {
    const m = new GxromMapper(rom({ prg: 8, chrRom: 4, mapper: 66 })); // 8×16K = 4×32K
    m.prgWrite(0x8001, (1 << 4) | 2); // PRG bank 1, CHR bank 2 ($8001 = 0xFF, no conflict)
    expect(m.prgRead(0x8000)).toBe(2); // 32 KiB bank 1 = 16 KiB bank 2
    expect(m.chrRead(0x0000)).toBe(0x82); // CHR bank 2 marker
  });
});

describe("ColorDreamsMapper", () => {
  it("selects a 32 KiB PRG bank (bits 0-1) and 8 KiB CHR bank (bits 4-7)", () => {
    const m = new ColorDreamsMapper(rom({ prg: 8, chrRom: 4, mapper: 11 }));
    m.prgWrite(0x8001, (3 << 4) | 1); // CHR bank 3, PRG bank 1 ($8001 = 0xFF, no conflict)
    expect(m.prgRead(0x8000)).toBe(2); // 32 KiB bank 1 = 16 KiB bank 2
    expect(m.chrRead(0x0000)).toBe(0x83); // CHR bank 3 marker
  });
});

describe("Bandai74Mapper", () => {
  it("switches the $8000 16 KiB bank + 8 KiB CHR; last bank fixed", () => {
    const m = new Bandai74Mapper(rom({ prg: 8, chrRom: 4, mapper: 70 }), false);
    m.prgWrite(0x8000, (2 << 4) | 1); // PRG bank 2, CHR bank 1
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xc000)).toBe(7); // last
    expect(m.chrRead(0x0000)).toBe(0x81); // CHR bank 1
  });
  it("mapper 152 selects single-screen mirroring via bit 7", () => {
    const m = new Bandai74Mapper(rom({ prg: 4, chrRom: 2, mapper: 152 }), true);
    m.prgWrite(0x8000, 0x00);
    expect(m.mirroring()).toBe("single-lower");
    m.prgWrite(0x8000, 0x80);
    expect(m.mirroring()).toBe("single-upper");
  });
});

describe("Nina03Mapper", () => {
  it("banks 32 KiB PRG (bit 3) + 8 KiB CHR (bits 0-2) via $4100", () => {
    const m = new Nina03Mapper(rom({ prg: 4, chrRom: 8, mapper: 79 })); // 4×16K = 2×32K
    m.lowWrite(0x4100, (1 << 3) | 5); // PRG bank 1, CHR bank 5
    expect(m.prgRead(0x8000)).toBe(2); // 32 KiB bank 1 = 16 KiB bank 2
    expect(m.chrRead(0x0000)).toBe(0x85); // CHR bank 5
  });
});

describe("CamericaMapper", () => {
  it("switches the $8000 bank via $C000 writes; last bank fixed at $C000", () => {
    const m = new CamericaMapper(rom({ prg: 8, chrRam: true, mapper: 71 }));
    expect(m.prgRead(0xc000)).toBe(7); // last bank
    m.prgWrite(0xc000, 3);
    expect(m.prgRead(0x8000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(7); // still fixed
    m.prgWrite(0x8000, 5); // writes below $C000 don't change the bank
    expect(m.prgRead(0x8000)).toBe(3);
  });
});

describe("NromMapper", () => {
  it("mirrors a 16 KiB PRG across both halves of $8000-$FFFF", () => {
    const m = new NromMapper(rom({ prg: 1, chrRom: 1, mapper: 0 }));
    expect(m.prgRead(0x8000)).toBe(0);
    expect(m.prgRead(0xc000)).toBe(0); // 16 KiB mirrored into the high window
  });
  it("maps a 32 KiB PRG directly at $8000 and $C000", () => {
    const m = new NromMapper(rom({ prg: 2, chrRom: 2, mapper: 0 }));
    expect(m.prgRead(0x8000)).toBe(0); // 16 KiB bank 0
    expect(m.prgRead(0xc000)).toBe(1); // 16 KiB bank 1
  });
  it("reads fixed 8 KiB CHR ROM and ignores writes", () => {
    const m = new NromMapper(rom({ prg: 1, chrRom: 1, mapper: 0 }));
    expect(m.chrRead(0x0000)).toBe(0x80); // CHR bank 0 marker
    m.chrWrite(0x0000, 0x12);
    expect(m.chrRead(0x0000)).toBe(0x80); // CHR ROM is read-only
  });
  it("uses CHR RAM (writable) when the header asks for it", () => {
    const m = new NromMapper(rom({ prg: 1, chrRam: true, mapper: 0 }));
    m.chrWrite(0x1abc, 0x5a);
    expect(m.chrRead(0x1abc)).toBe(0x5a);
  });
  it("has no PRG registers (prgWrite is a no-op)", () => {
    const m = new NromMapper(rom({ prg: 2, chrRom: 2, mapper: 0 }));
    m.prgWrite(); // NROM ignores PRG-space writes (no banking)
    expect(m.prgRead(0x8000)).toBe(0); // unchanged
  });
  it("reports the header-fixed mirroring", () => {
    expect(new NromMapper(rom({ prg: 1, chrRom: 1, mapper: 0, mirroring: "horizontal" })).mirroring()).toBe(
      "horizontal"
    );
    expect(new NromMapper(rom({ prg: 1, chrRom: 1, mapper: 0, mirroring: "vertical" })).mirroring()).toBe("vertical");
  });
});

describe("BnromMapper", () => {
  it("switches the 32 KiB PRG bank via $8000 writes", () => {
    const m = new BnromMapper(rom({ prg: 4, chrRam: true, mapper: 34 })); // 4×16K = 2×32K
    expect(m.prgRead(0x8000)).toBe(0); // 32 KiB bank 0 = 16 KiB bank 0
    expect(m.prgRead(0xc000)).toBe(1); // 16 KiB bank 1
    m.prgWrite(0x8000, 1);
    expect(m.prgRead(0x8000)).toBe(2); // 32 KiB bank 1 = 16 KiB bank 2
    expect(m.prgRead(0xc000)).toBe(3); // 16 KiB bank 3
  });
  it("NINA-001 work-RAM registers: $7FFD PRG + $7FFE/$7FFF 4 KiB CHR banks", () => {
    const m = new BnromMapper(rom({ prg: 4, chrRom: 2, mapper: 34 })); // CHR: 2×8K = 4×4K
    m.lowWrite(0x7ffd, 1); // 32 KiB PRG bank 1
    expect(m.prgRead(0x8000)).toBe(2);
    m.lowWrite(0x7ffe, 2); // $0000-$0FFF -> 4 KiB CHR bank 2 (= 8 KiB bank 1)
    expect(m.chrRead(0x0000)).toBe(0x81); // CHR bank 1 marker sits at 4 KiB bank 2 offset 0
    m.lowWrite(0x7fff, 1); // $1000-$1FFF -> 4 KiB CHR bank 1 (mid 8 KiB bank 0, no marker)
    expect(m.chrRead(0x1000)).toBe(0x00);
  });
  it("CHR RAM is writable; ROM is not", () => {
    const ram = new BnromMapper(rom({ prg: 2, chrRam: true, mapper: 34 }));
    ram.chrWrite(0x0123, 0x77);
    expect(ram.chrRead(0x0123)).toBe(0x77);
    const r = new BnromMapper(rom({ prg: 2, chrRom: 1, mapper: 34 }));
    r.chrWrite(0x0000, 0x12);
    expect(r.chrRead(0x0000)).toBe(0x80); // CHR ROM unchanged
  });
});

describe("CpromMapper", () => {
  it("fixes the low CHR half to bank 0 and banks the high half via $8000 writes", () => {
    const m = new CpromMapper(rom({ prg: 2, chrRam: true, mapper: 13 }));
    // Tag each 4 KiB CHR-RAM bank at high-half offset 0x800 through the register.
    // ($1000 maps to bank 0 too, which aliases the always-fixed low half, so use
    // a mid-bank offset that is distinct from the $0000 low-half tag.)
    for (let bank = 0; bank < 4; bank++) {
      m.prgWrite(0x8000, bank);
      m.chrWrite(0x1800, 0xa0 | bank);
    }
    m.chrWrite(0x0000, 0xcc); // fixed low half (bank 0)
    m.prgWrite(0x8000, 2);
    expect(m.chrRead(0x0000)).toBe(0xcc); // low half is always bank 0
    expect(m.chrRead(0x1800)).toBe(0xa2); // high half follows the selected bank
    m.prgWrite(0x8000, 3);
    expect(m.chrRead(0x1800)).toBe(0xa3);
    m.prgWrite(0x8000, 0); // selecting bank 0 maps the high window to bank 0
    expect(m.chrRead(0x1800)).toBe(0xa0);
  });
  it("masks the bank select to two bits", () => {
    const m = new CpromMapper(rom({ prg: 2, chrRam: true, mapper: 13 }));
    m.prgWrite(0x8000, 1);
    m.chrWrite(0x1000, 0x11);
    m.prgWrite(0x8000, 0xfd); // 0xFD & 0x03 == 1
    expect(m.chrRead(0x1000)).toBe(0x11);
  });
  it("maps a fixed 32 KiB PRG", () => {
    const m = new CpromMapper(rom({ prg: 2, chrRam: true, mapper: 13 }));
    expect(m.prgRead(0x8000)).toBe(0);
    expect(m.prgRead(0xc000)).toBe(1);
    m.prgWrite(0x8000, 3); // PRG is fixed; writes only touch CHR
    expect(m.prgRead(0x8000)).toBe(0);
  });
});

describe("QuattroMapper", () => {
  it("picks a 64 KiB block via $8000 and a 16 KiB page via $C000; $C000 window is the block's last page", () => {
    const m = new QuattroMapper(rom({ prg: 16, chrRam: true, mapper: 232 })); // 256 KiB = 4 blocks
    expect(m.prgRead(0x8000)).toBe(0); // block 0, page 0
    expect(m.prgRead(0xc000)).toBe(3); // block 0, last page (3)
    m.prgWrite(0x8000, 0x08); // block = ((0x08>>3)&3)<<2 = 4 (block index 1)
    m.prgWrite(0xc000, 2); // page 2 within block
    expect(m.prgRead(0x8000)).toBe(6); // block 1 page 2 = 16 KiB bank 4|2 = 6
    expect(m.prgRead(0xc000)).toBe(7); // block 1 last page = 4|3 = 7
  });
  it("CHR RAM is writable", () => {
    const m = new QuattroMapper(rom({ prg: 4, chrRam: true, mapper: 232 }));
    m.chrWrite(0x0abc, 0x3c);
    expect(m.chrRead(0x0abc)).toBe(0x3c);
  });
});

describe("Sunsoft4Mapper", () => {
  it("banks 16 KiB PRG at $8000 (last fixed at $C000) and four 2 KiB CHR banks", () => {
    const m = new Sunsoft4Mapper(rom({ prg: 8, chrRom: 4, mapper: 68 })); // CHR: 4×8K = 16×2K
    expect(m.prgRead(0x8000)).toBe(0);
    expect(m.prgRead(0xc000)).toBe(7); // last 16 KiB bank fixed
    m.prgWrite(0xf000, 3); // $F000 -> 16 KiB PRG bank 3
    expect(m.prgRead(0x8000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(7); // still fixed

    m.prgWrite(0x8000, 4); // 2 KiB CHR bank 4 -> $0000 (4×2K = 8 KiB bank 1)
    expect(m.chrRead(0x0000)).toBe(0x81);
    m.prgWrite(0xb000, 8); // 2 KiB CHR bank 8 -> $1800 (8×2K = 8 KiB bank 2)
    expect(m.chrRead(0x1800)).toBe(0x82);
  });
  it("selects nametable-replacement mirroring via $E000", () => {
    const m = new Sunsoft4Mapper(rom({ prg: 4, chrRom: 1, mapper: 68 }));
    m.prgWrite(0xe000, 0);
    expect(m.mirroring()).toBe("vertical");
    m.prgWrite(0xe000, 1);
    expect(m.mirroring()).toBe("horizontal");
    m.prgWrite(0xe000, 2);
    expect(m.mirroring()).toBe("single-lower");
    m.prgWrite(0xe000, 3);
    expect(m.mirroring()).toBe("single-upper");
  });
});

describe("Nina113Mapper", () => {
  it("decodes $4100: PRG (bits 3-5), CHR (bit 6 + bits 0-2), and mirroring (bit 7)", () => {
    const m = new Nina113Mapper(rom({ prg: 4, chrRom: 8, mapper: 113 })); // 4×16K = 2×32K, 8×8K CHR
    m.lowWrite(0x4100, (1 << 3) | 5); // PRG bank 1, CHR bank 5, mirroring bit clear
    expect(m.prgRead(0x8000)).toBe(2); // 32 KiB bank 1 = 16 KiB bank 2
    expect(m.chrRead(0x0000)).toBe(0x85); // CHR bank 5
    expect(m.mirroring()).toBe("horizontal");
  });
  it("uses bit 6 as the CHR high bit and bit 7 for mirroring", () => {
    const m = new Nina113Mapper(rom({ prg: 2, chrRom: 8, mapper: 113 }));
    // bit 6 set + low CHR bits 1 -> bank (1 | (0x40>>3)) = 1 | 8 = 9 (mod 8 = 1)
    m.lowWrite(0x4100, 0x40 | 0x01 | 0x80);
    expect(m.chrRead(0x0000)).toBe(0x81); // CHR bank 9 % 8 = 1
    expect(m.mirroring()).toBe("vertical"); // bit 7 set
  });
  it("ignores writes outside the $4100 decode", () => {
    const m = new Nina113Mapper(rom({ prg: 4, chrRom: 8, mapper: 113 }));
    m.lowWrite(0x4100, (1 << 3) | 3); // set a known state
    m.lowWrite(0x4000, (1 << 3) | 7); // not decoded ((0x4000 & 0xE100) != 0x4100)
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.chrRead(0x0000)).toBe(0x83);
  });
});
