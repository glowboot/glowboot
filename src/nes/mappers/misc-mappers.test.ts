/**
 * Misc + expansion-audio + IRQ mappers — the long tail that doesn't fit the
 * one-mapper-per-file pattern. Covers the Konami VRC family (VRC2/4 via Vrc24,
 * VRC3, VRC1, VRC6, VRC7) plus a grab-bag of others: Sunsoft-3, RAMBO-1, the
 * MMC3 clones (TQROM, Namco-108/206, mapper 189, Waixing 245), Jaleco-87,
 * mapper 185, Namco 210/175/340, Jaleco SS88006, MMC5, Namco 163, and the Irem
 * H3001. Banking, mirroring, the scanline/cycle IRQ counters, and the
 * expansion-audio chips are all asserted against documented nesdev behaviour.
 */

import { describe, expect, it } from "vitest";

import type { NesRom } from "../cartridge/rom.js";
import { BandaiFcgMapper } from "./bandai-fcg.js";
import { Mapper185 } from "./cnrom185.js";
import { IremTamS1Mapper, Nichibutsu180Mapper, Sunsoft1Mapper, Sunsoft2Mapper, Un1romMapper } from "./discrete.js";
import { Fme7Mapper } from "./fme7.js";
import { IremG101Mapper } from "./irem-g101.js";
import { IremH3001Mapper } from "./irem-h3001.js";
import { Jaleco72Mapper, Jaleco86Mapper, Jaleco92Mapper, Jaleco140Mapper } from "./jaleco-simple.js";
import { JalecoSs88006Mapper } from "./jaleco-ss88006.js";
import { Jaleco87Mapper } from "./jaleco87.js";
import { Mapper189, Mapper206, TqromMapper, TxSromMapper, Waixing245Mapper } from "./mmc3-clones.js";
import { Mmc5Mapper } from "./mmc5.js";
import { Mapper76, Mapper88, Mapper95, Mapper154 } from "./namco108.js";
import { Namco163Mapper } from "./namco163.js";
import { Namco210Mapper } from "./namco210.js";
import { Rambo1Mapper } from "./rambo1.js";
import { Sunsoft3Mapper } from "./sunsoft3.js";
import { TaitoTc0190Mapper, TaitoTc0690Mapper } from "./taito-tc0190.js";
import { TaitoX1005Mapper, TaitoX1017Mapper } from "./taito-x1.js";
import { Vrc1Mapper } from "./vrc1.js";
import { Vrc3Mapper } from "./vrc3.js";
import { Vrc6Mapper } from "./vrc6.js";
import { Vrc7Mapper } from "./vrc7.js";
import { Vrc24Mapper } from "./vrc24.js";

/** Markers at 8 KiB PRG granularity (value = 8 KiB bank index) and 1 KiB CHR
 *  granularity, so any sub-bank read maps cleanly back to its bank number. */
function rom(opts: { prg16k: number; chr8k?: number; chrRam?: boolean; mapper: number; submapper?: number }): NesRom {
  const prgRom = new Uint8Array(opts.prg16k * 0x4000).fill(0xff);
  for (let b = 0; b * 0x2000 < prgRom.length; b++) prgRom[b * 0x2000] = b & 0xff;
  const chrRom = new Uint8Array((opts.chr8k ?? 0) * 0x2000);
  for (let b = 0; b * 0x400 < chrRom.length; b++) chrRom[b * 0x400] = b & 0xff;
  return {
    prgRom,
    chrRom,
    usesChrRam: opts.chrRam ?? false,
    chrRamSize: opts.chrRam ? 0x2000 : 0,
    prgRamSize: 0x2000,
    prgNvramSize: 0,
    mapper: opts.mapper,
    submapper: opts.submapper ?? 0,
    mirroring: "vertical",
    battery: false,
    region: "ntsc",
    nes2: false
  };
}

describe("Vrc24Mapper (VRC4, mapper 23)", () => {
  it("banks the two switchable 8 KiB PRG windows; $E000 fixed last", () => {
    const m = new Vrc24Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 23 }));
    m.prgWrite(0x8000, 2);
    m.prgWrite(0xa000, 3);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xe000)).toBe(7); // 8 KiB bank 7 = last
  });
  it("swap mode moves the $8000 bank to $C000", () => {
    const m = new Vrc24Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 23 }));
    m.prgWrite(0x8000, 2);
    m.prgWrite(0x9002, 0x02); // sel 2 in $9xxx → swap mode
    expect(m.prgRead(0xc000)).toBe(2);
    expect(m.prgRead(0x8000)).toBe(6); // penultimate
  });
  it("assembles a 1 KiB CHR bank from low/high nibble writes", () => {
    const m = new Vrc24Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 23 }));
    m.prgWrite(0xb000, 5); // PPU $0000 low nibble
    expect(m.chrRead(0x0000)).toBe(5);
  });
  it("sets mirroring and runs the cycle-mode IRQ", () => {
    const m = new Vrc24Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 23 }));
    m.prgWrite(0x9000, 1);
    expect(m.mirroring()).toBe("horizontal");
    m.prgWrite(0xf000, 0x0e); // latch low
    m.prgWrite(0xf001, 0x0f); // latch high → 0xFE
    m.prgWrite(0xf002, 0x06); // enable + cycle mode
    expect(m.irqState()).toBe(false);
    m.tick(2);
    expect(m.irqState()).toBe(true);
  });
});

describe("Vrc24Mapper (VRC2a, mapper 22)", () => {
  it("right-shifts every CHR bank by one and has no IRQ", () => {
    const m = new Vrc24Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 22 }));
    m.prgWrite(0x8000, 3);
    expect(m.prgRead(0x8000)).toBe(3);
    m.prgWrite(0xb000, 4); // PPU $0000 low nibble = 4 → bank 4 >>1 = 2
    expect(m.chrRead(0x0000)).toBe(2);
    m.tick(10_000);
    expect(m.irqState()).toBe(false);
  });
});

describe("Vrc3Mapper (mapper 73)", () => {
  it("switches the 16 KiB PRG bank via $F000; $C000 fixed", () => {
    const m = new Vrc3Mapper(rom({ prg16k: 4, chrRam: true, mapper: 73 }));
    m.prgWrite(0xf000, 2);
    expect(m.prgRead(0x8000)).toBe(4); // 16 KiB bank 2 = 8 KiB bank 4
    expect(m.prgRead(0xc000)).toBe(6); // last 16 KiB bank 3 = 8 KiB bank 6
  });
  it("runs the 16-bit cycle IRQ", () => {
    const m = new Vrc3Mapper(rom({ prg16k: 4, chrRam: true, mapper: 73 }));
    for (const reg of [0x8000, 0x9000, 0xa000, 0xb000]) m.prgWrite(reg, 0x0f); // latch 0xFFFF
    m.prgWrite(0xc000, 0x02); // enable, 16-bit mode
    expect(m.irqState()).toBe(false);
    m.tick(1);
    expect(m.irqState()).toBe(true);
  });
});

describe("Vrc1Mapper (mapper 75)", () => {
  it("banks three PRG windows + fixed last and 4 KiB CHR", () => {
    const m = new Vrc1Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 75 }));
    m.prgWrite(0x8000, 2);
    m.prgWrite(0xa000, 3);
    m.prgWrite(0xc000, 5);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(5);
    expect(m.prgRead(0xe000)).toBe(7); // last
    m.prgWrite(0xe000, 1); // CHR bank 0 (4 KiB) low nibble → 1 KiB marker 4
    expect(m.chrRead(0x0000)).toBe(4);
    m.prgWrite(0x9000, 1);
    expect(m.mirroring()).toBe("horizontal");
  });
});

describe("Sunsoft3Mapper (mapper 67)", () => {
  it("banks 16 KiB PRG + four 2 KiB CHR and switches mirroring", () => {
    const m = new Sunsoft3Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 67 }));
    m.prgWrite(0xf800, 2);
    expect(m.prgRead(0x8000)).toBe(4); // 16 KiB bank 2
    expect(m.prgRead(0xc000)).toBe(6); // fixed last
    m.prgWrite(0x8800, 3); // CHR window 0 (2 KiB) → 1 KiB marker 6
    expect(m.chrRead(0x0000)).toBe(6);
    m.prgWrite(0xe800, 1);
    expect(m.mirroring()).toBe("horizontal");
  });
  it("loads the IRQ counter high-then-low and counts down", () => {
    const m = new Sunsoft3Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 67 }));
    m.prgWrite(0xd800, 0x10); // enable + reset byte toggle
    m.prgWrite(0xc800, 0x00); // high byte
    m.prgWrite(0xc800, 0x01); // low byte → counter 0x0001
    expect(m.irqState()).toBe(false);
    m.tick(2); // 1 → 0 → underflow asserts
    expect(m.irqState()).toBe(true);
  });
});

describe("Rambo1Mapper (mapper 64)", () => {
  it("banks three switchable 8 KiB PRG windows (mode 0) + fixed last", () => {
    const m = new Rambo1Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 64 }));
    m.prgWrite(0x8000, 6); // command: select R6 (P=0)
    m.prgWrite(0x8001, 2);
    m.prgWrite(0x8000, 7); // R7
    m.prgWrite(0x8001, 3);
    m.prgWrite(0x8000, 0x0f); // R15
    m.prgWrite(0x8001, 5);
    expect(m.prgRead(0x8000)).toBe(2); // R6
    expect(m.prgRead(0xa000)).toBe(3); // R7
    expect(m.prgRead(0xc000)).toBe(5); // R15
    expect(m.prgRead(0xe000)).toBe(7); // fixed last
  });
  it("maps 1 KiB CHR in K=1 mode and runs the scanline IRQ", () => {
    const m = new Rambo1Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 64 }));
    m.prgWrite(0x8000, 0x20); // command: select R0, K=1 (1 KiB CHR)
    m.prgWrite(0x8001, 3);
    expect(m.chrRead(0x0000)).toBe(3); // R0 at PPU $0000
    m.prgWrite(0xc000, 2); // IRQ latch
    m.prgWrite(0xc001, 0); // reload
    m.prgWrite(0xe001, 0); // enable
    m.clockIrq(); // reload → 2
    m.clockIrq(); // 1
    expect(m.irqState()).toBe(false);
    m.clockIrq(); // 0 → assert
    expect(m.irqState()).toBe(true);
  });
});

describe("IremH3001Mapper (mapper 65)", () => {
  it("banks the three switchable 8 KiB PRG windows with $E000 fixed last", () => {
    const m = new IremH3001Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 65 }));
    m.prgWrite(0x8000, 2);
    m.prgWrite(0xa000, 3);
    m.prgWrite(0xc000, 5);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(5);
    expect(m.prgRead(0xe000)).toBe(7); // fixed last 8 KiB bank
  });

  it("powers on with the top 32 KiB mapped into the switchable slots", () => {
    const m = new IremH3001Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 65 })); // 8 x 8 KiB banks
    // Games JSR into $C000 space during reset before writing the bank registers,
    // so the slots must default to banks N-4/N-3/N-2 (with $E000 fixed at N-1).
    expect(m.prgRead(0x8000)).toBe(4);
    expect(m.prgRead(0xa000)).toBe(5);
    expect(m.prgRead(0xc000)).toBe(6);
    expect(m.prgRead(0xe000)).toBe(7);
  });

  it("selects each of the eight 1 KiB CHR banks via $B000-$B007", () => {
    const m = new IremH3001Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 65 }));
    m.prgWrite(0xb000, 5); // PPU $0000
    m.prgWrite(0xb007, 3); // PPU $1C00
    expect(m.chrRead(0x0000)).toBe(5);
    expect(m.chrRead(0x1c00)).toBe(3);
  });

  it("switches mirroring from $9001 bit 7", () => {
    const m = new IremH3001Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 65 }));
    m.prgWrite(0x9001, 0x80);
    expect(m.mirroring()).toBe("horizontal");
    m.prgWrite(0x9001, 0x00);
    expect(m.mirroring()).toBe("vertical");
  });

  it("loads the 16-bit IRQ counter high-then-low and counts down per CPU cycle", () => {
    const m = new IremH3001Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 65 }));
    m.prgWrite(0x9005, 0x00); // latch high byte
    m.prgWrite(0x9006, 0x02); // latch low byte → 0x0002
    m.prgWrite(0x9004, 0x00); // reload counter from latch
    m.prgWrite(0x9003, 0x80); // enable
    expect(m.irqState()).toBe(false);
    m.tick(1); // 2 → 1
    expect(m.irqState()).toBe(false);
    m.tick(1); // 1 → 0 → assert
    expect(m.irqState()).toBe(true);
  });

  it("only counts down while the IRQ is enabled", () => {
    const m = new IremH3001Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 65 }));
    m.prgWrite(0x9005, 0x00);
    m.prgWrite(0x9006, 0x02);
    m.prgWrite(0x9004, 0x00); // reload → 0x0002, but not enabled
    m.tick(10); // disabled → no countdown
    expect(m.irqState()).toBe(false);
    m.prgWrite(0x9003, 0x80); // enable
    m.tick(2); // 2 → 0 → assert
    expect(m.irqState()).toBe(true);
  });

  it("acknowledges pending IRQ on enable ($9003) and reload ($9004) writes", () => {
    const m = new IremH3001Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 65 }));
    m.prgWrite(0x9006, 0x01); // latch low → 0x0001
    m.prgWrite(0x9004, 0x00); // reload
    m.prgWrite(0x9003, 0x80); // enable
    m.tick(1); // 1 → 0 → assert
    expect(m.irqState()).toBe(true);
    m.prgWrite(0x9004, 0x00); // reload acknowledges
    expect(m.irqState()).toBe(false);
    m.tick(1); // 1 → 0 → assert again
    expect(m.irqState()).toBe(true);
    m.prgWrite(0x9003, 0x80); // enable write acknowledges
    expect(m.irqState()).toBe(false);
  });
});

describe("MMC3 clones", () => {
  it("TQROM (119) routes CHR bank bit 6 to 8 KiB CHR-RAM", () => {
    const m = new TqromMapper(rom({ prg16k: 4, chr8k: 8, mapper: 119 }));
    m.prgWrite(0x8000, 2); // bank select → R2 (PPU $1000, 1 KiB)
    m.prgWrite(0x8001, 5); // ROM bank 5
    expect(m.chrRead(0x1000)).toBe(5);
    m.prgWrite(0x8001, 0x40); // bit 6 set → CHR-RAM bank 0
    m.chrWrite(0x1000, 0xab);
    expect(m.chrRead(0x1000)).toBe(0xab);
  });
  it("Namco 108 (206) banks PRG/CHR but ignores mode bits, mirroring, IRQ", () => {
    const m = new Mapper206(rom({ prg16k: 4, chr8k: 8, mapper: 206 })); // header = vertical
    m.prgWrite(0x8000, 6); // select R6 ($8000)
    m.prgWrite(0x8001, 2);
    m.prgWrite(0x8000, 7); // select R7 ($A000)
    m.prgWrite(0x8001, 3);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(6); // fixed penultimate (8 banks → 6)
    expect(m.prgRead(0xe000)).toBe(7); // fixed last
    m.prgWrite(0x8000, 2); // select R2 (CHR 1 KiB at PPU $1000)
    m.prgWrite(0x8001, 5);
    expect(m.chrRead(0x1000)).toBe(5);
    // Bit 6/7 in the command must NOT enable PRG/CHR mode swaps.
    m.prgWrite(0x8000, 0x46); // command 6 with bit 6 set
    m.prgWrite(0x8001, 1);
    expect(m.prgRead(0x8000)).toBe(1); // still R6 at $8000, no swap
    // $A000 writes are unconnected — mirroring stays fixed from the header.
    m.prgWrite(0xa000, 1);
    expect(m.mirroring()).toBe("vertical");
  });
  it("mapper 189 selects a single 32 KiB PRG bank via $4120", () => {
    const m = new Mapper189(rom({ prg16k: 4, chr8k: 8, mapper: 189 }));
    m.lowWrite(0x4120, 0x11); // 32 KiB bank 1
    expect(m.prgRead(0x8000)).toBe(4); // bank1×4 + region0 = 8 KiB bank 4
    expect(m.prgRead(0xe000)).toBe(7); // +region3
  });
  it("Waixing 245 adds a PRG outer bank from R0 bit 1", () => {
    const m = new Waixing245Mapper(rom({ prg16k: 64, chr8k: 8, mapper: 245 }));
    m.prgWrite(0x8000, 0x00); // bank select → R0
    m.prgWrite(0x8001, 0x02); // R0 bit 1 set → outer block 0x40
    expect(m.prgRead(0x8000)).toBe(64); // R6=0 + outer 0x40
    m.prgWrite(0x8001, 0x00); // clear outer
    expect(m.prgRead(0x8000)).toBe(0);
  });
});

describe("Jaleco87Mapper (mapper 87)", () => {
  it("selects the 8 KiB CHR bank from $6000 with D0/D1 swapped", () => {
    const m = new Jaleco87Mapper(rom({ prg16k: 2, chr8k: 4, mapper: 87 }));
    m.lowWrite(0x6000, 1); // D0=1,D1=0 → bank 2
    expect(m.chrRead(0x0000)).toBe(16); // 8 KiB bank 2 = 1 KiB marker 16
    m.lowWrite(0x6000, 2); // D0=0,D1=1 → bank 1
    expect(m.chrRead(0x0000)).toBe(8); // 8 KiB bank 1 = 1 KiB marker 8
  });
});

describe("Mapper185 (CNROM security)", () => {
  it("gates CHR reads on the chip-select security value (submapper 5)", () => {
    const m = new Mapper185(rom({ prg16k: 2, chr8k: 1, mapper: 185, submapper: 5 }));
    m.prgWrite(0x8000, 0x01); // CS=1 matches submapper 5 → unlocked
    expect(m.chrRead(0x0000)).toBe(0); // CHR marker
    m.prgWrite(0x8000, 0x00); // CS=0 → locked → open bus
    expect(m.chrRead(0x0000)).toBe(0xff);
  });
});

describe("Namco210Mapper (mapper 210)", () => {
  it("banks PRG/CHR; Namco 175 keeps header mirroring", () => {
    const m = new Namco210Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 210, submapper: 1 }));
    m.prgWrite(0xe000, 2);
    m.prgWrite(0xe800, 3);
    m.prgWrite(0xf000, 5);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(5);
    expect(m.prgRead(0xe000)).toBe(7); // fixed last
    m.prgWrite(0x8000, 5); // CHR 0
    expect(m.chrRead(0x0000)).toBe(5);
    m.prgWrite(0xe000, 0xc0); // would set mirroring on 340; 175 ignores it
    expect(m.mirroring()).toBe("vertical");
  });
  it("Namco 340 (submapper 2) takes mirroring from $E000 bits 7-6", () => {
    const m = new Namco210Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 210, submapper: 2 }));
    m.prgWrite(0xe000, 0x40); // bits 7-6 = 1 → vertical
    expect(m.mirroring()).toBe("vertical");
    m.prgWrite(0xe000, 0xc0); // bits 7-6 = 3 → horizontal
    expect(m.mirroring()).toBe("horizontal");
  });
});

describe("JalecoSs88006Mapper (mapper 18)", () => {
  it("banks PRG/CHR via nibble pairs and switches mirroring", () => {
    const m = new JalecoSs88006Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 18 }));
    m.prgWrite(0x8000, 2); // PRG0 low nibble
    m.prgWrite(0x8002, 3); // PRG1 low nibble
    m.prgWrite(0x9000, 5); // PRG2 low nibble
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(5);
    expect(m.prgRead(0xe000)).toBe(7); // fixed last
    m.prgWrite(0xa000, 5); // CHR0 low nibble
    expect(m.chrRead(0x0000)).toBe(5);
    m.prgWrite(0xf002, 1);
    expect(m.mirroring()).toBe("vertical");
  });
  it("runs the width-masked down-counter IRQ", () => {
    const m = new JalecoSs88006Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 18 }));
    m.prgWrite(0xe000, 3); // latch low nibble = 3 → latch 0x0003
    m.prgWrite(0xf000, 0); // reload counter from latch
    m.prgWrite(0xf001, 0x01); // 16-bit width + enable
    m.tick(3);
    expect(m.irqState()).toBe(false);
    m.tick(1); // counter hits 0 → underflow asserts
    expect(m.irqState()).toBe(true);
  });
});

describe("Mmc5Mapper (mapper 5)", () => {
  it("banks 8 KiB PRG in mode 3 with $E000 fixed last by default", () => {
    const m = new Mmc5Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 5 }));
    m.lowWrite(0x5100, 3); // 8 KiB PRG mode
    m.lowWrite(0x5114, 2); // $8000
    m.lowWrite(0x5115, 3); // $A000
    m.lowWrite(0x5116, 5); // $C000
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(5);
    expect(m.prgRead(0xe000)).toBe(7); // $5117 powers on at last bank
  });
  it("banks 1 KiB CHR in mode 3 and exposes the multiplier", () => {
    const m = new Mmc5Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 5 }));
    m.lowWrite(0x5101, 3); // 1 KiB CHR mode
    m.lowWrite(0x5120, 5); // PPU $0000
    expect(m.chrRead(0x0000)).toBe(5);
    m.lowWrite(0x5205, 7);
    m.lowWrite(0x5206, 6);
    expect(m.lowRead(0x5205)).toBe(42 & 0xff); // 7 × 6
    expect(m.lowRead(0x5206)).toBe(0);
  });
  it("banks the background from the $5128-$512B set in 8x16-sprite mode", () => {
    const m = new Mmc5Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 5 }));
    m.lowWrite(0x5101, 3); // 1 KiB CHR mode
    m.lowWrite(0x5120, 1); // sprite set (A) bank at $0000
    m.lowWrite(0x5128, 9); // background set (B) bank at $0000
    m.setLargeSprites!(false); // 8x8: background and sprites both use set A
    expect(m.chrRead(0x0000)).toBe(1);
    expect(m.chrReadSprite!(0x0000)).toBe(1);
    m.setLargeSprites!(true); // 8x16: background uses set B, sprites stay on set A
    expect(m.chrRead(0x0000)).toBe(9);
    expect(m.chrRead(0x1000)).toBe(9); // background mirrors both pattern halves
    expect(m.chrReadSprite!(0x0000)).toBe(1);
  });
  it("maps each nametable to CIRAM, ExRAM, or fill via $5105", () => {
    const m = new Mmc5Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 5 }));
    const ciram = new Uint8Array(0x800);
    ciram[0x000] = 0x11; // page 0
    ciram[0x400] = 0x22; // page 1
    m.lowWrite(0x5104, 0); // ExRAM mode 0 (usable as a nametable)
    m.lowWrite(0x5c00, 0x33); // ExRAM byte 0
    m.lowWrite(0x5106, 0x44); // fill tile
    m.lowWrite(0x5107, 0x02); // fill colour 2
    m.lowWrite(0x5105, 0xe4); // nt0→CIRAM0, nt1→CIRAM1, nt2→ExRAM, nt3→fill
    expect(m.ppuNametableByte!(0x2000, ciram)).toBe(0x11);
    expect(m.ppuNametableByte!(0x2400, ciram)).toBe(0x22);
    expect(m.ppuNametableByte!(0x2800, ciram)).toBe(0x33);
    expect(m.ppuNametableByte!(0x2c00, ciram)).toBe(0x44); // fill tile region
    expect(m.ppuNametableByte!(0x2fc0, ciram)).toBe(0x02 * 0x55); // fill attribute region
  });
  it("fires the scanline-compare IRQ", () => {
    const m = new Mmc5Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 5 }));
    m.lowWrite(0x5203, 3); // target scanline 3
    m.lowWrite(0x5204, 0x80); // enable
    m.clockIrq();
    m.clockIrq();
    expect(m.irqState()).toBe(false);
    m.clockIrq(); // scanline 3
    expect(m.irqState()).toBe(true);
    expect(m.lowRead(0x5204)! & 0x80).toBe(0x80); // status reflects pending, then clears
    expect(m.irqState()).toBe(false);
  });
  it("emits pulse + PCM audio", () => {
    const m = new Mmc5Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 5 }));
    const audio = m.audio()!;
    m.lowWrite(0x5015, 0x01); // enable pulse 1
    m.lowWrite(0x5000, 0xbf); // duty 2, constant volume 15
    m.lowWrite(0x5002, 0x40); // timer low
    m.lowWrite(0x5003, 0x08); // timer high + length load
    let high = false;
    for (let i = 0; i < 2000; i++) {
      audio.clock();
      if (audio.output() > 0) high = true;
    }
    expect(high).toBe(true);
    m.lowWrite(0x5011, 200); // PCM DAC
    expect(audio.output()).toBeGreaterThan(0);
  });
});

describe("Namco163Mapper (mapper 19)", () => {
  it("banks PRG via $E000/$E800/$F000 with $E000 fixed last", () => {
    const m = new Namco163Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 19 }));
    m.prgWrite(0xe000, 2);
    m.prgWrite(0xe800, 3);
    m.prgWrite(0xf000, 5);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(5);
    expect(m.prgRead(0xe000)).toBe(7); // fixed last
  });
  it("auto-increments the sound RAM port and runs the 15-bit IRQ", () => {
    const m = new Namco163Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 19 }));
    m.prgWrite(0xf800, 0x80 | 0x10); // sound addr 0x10, auto-increment
    m.lowWrite(0x4800, 0xab);
    m.lowWrite(0x4800, 0xcd);
    m.prgWrite(0xf800, 0x80 | 0x10);
    expect(m.lowRead(0x4800)).toBe(0xab);
    expect(m.lowRead(0x4800)).toBe(0xcd);
    m.lowWrite(0x5000, 0xf0); // counter low
    m.lowWrite(0x5800, 0x80 | 0x7f); // counter high + enable → 0x7ff0
    expect(m.irqState()).toBe(false);
    m.tick(16); // 0x7ff0 + 16 = 0x8000 ≥ 0x7fff → assert
    expect(m.irqState()).toBe(true);
  });
  it("emits wavetable audio", () => {
    const m = new Namco163Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 19 }));
    const audio = m.audio()!;
    // One channel (reg $7F bits 6-4 = 0), a non-zero waveform, volume, frequency.
    const set = (a: number, v: number) => {
      m.prgWrite(0xf800, a); // sound address (no auto-inc)
      m.lowWrite(0x4800, v); // sound data
    };
    for (let i = 0; i < 8; i++) set(i, 0xf0); // wave nibbles alternate 0/15
    // The active channel for a 1-channel config is slot 7 (registers at 0x78).
    set(0x78, 0x40); // channel 7 frequency low
    set(0x7c, 0x00); // freq high + wave length (full)
    set(0x7e, 0x00); // wave address 0
    set(0x7f, 0x0f); // volume max; channel-count bits 6-4 = 0 (1 channel)
    let nonzero = false;
    for (let i = 0; i < 4000; i++) {
      audio.clock();
      if (audio.output() !== 0) nonzero = true;
    }
    expect(nonzero).toBe(true);
  });
});

describe("Vrc6Mapper (mapper 24)", () => {
  it("banks 16 KiB + 8 KiB PRG, 1 KiB CHR, and sets mirroring", () => {
    const m = new Vrc6Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 24 }));
    m.prgWrite(0x8000, 1); // 16 KiB bank 1
    m.prgWrite(0xc000, 3); // 8 KiB bank 3
    expect(m.prgRead(0x8000)).toBe(2); // 16 KiB bank 1 = 8 KiB bank 2
    expect(m.prgRead(0xc000)).toBe(3);
    expect(m.prgRead(0xe000)).toBe(7); // fixed last 8 KiB
    m.prgWrite(0xd000, 5); // CHR R0
    expect(m.chrRead(0x0000)).toBe(5);
    m.prgWrite(0xb003, 0x04); // mirroring bits → horizontal
    expect(m.mirroring()).toBe("horizontal");
  });
  it("produces expansion audio from a pulse channel", () => {
    const m = new Vrc6Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 24 }));
    const audio = m.audio()!;
    expect(audio.output()).toBe(0);
    m.prgWrite(0x9000, 0x80 | 0x0a); // mode (constant) + volume 10
    m.prgWrite(0x9002, 0x80); // enable
    expect(audio.output()).toBeGreaterThan(0);
  });
});

describe("Vrc7Mapper (mapper 85)", () => {
  it("banks 8 KiB PRG ($8000/$8010/$9000), 1 KiB CHR, and mirroring", () => {
    const m = new Vrc7Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 85 }));
    m.prgWrite(0x8000, 2);
    m.prgWrite(0x8010, 3);
    m.prgWrite(0x9000, 5);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(3);
    expect(m.prgRead(0xc000)).toBe(5);
    expect(m.prgRead(0xe000)).toBe(7); // fixed last
    m.prgWrite(0xa000, 4); // CHR 0
    expect(m.chrRead(0x0000)).toBe(4);
    m.prgWrite(0xe000, 1); // mirroring
    expect(m.mirroring()).toBe("horizontal");
  });
  it("produces FM output after keying a note on", () => {
    const m = new Vrc7Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 85 }));
    const audio = m.audio()!;
    const reg = (a: number, v: number) => {
      m.prgWrite(0x9010, a); // address port
      m.prgWrite(0x9030, v); // data port
    };
    reg(0x30, 0x10); // channel 0: instrument 1, volume 0 (loud)
    reg(0x10, 0x40); // F-num low
    reg(0x20, 0x10 | (4 << 1) | 1); // key-on, block 4, F-num high bit
    let nonzero = false;
    for (let i = 0; i < 20000; i++) {
      audio.clock();
      if (audio.output() !== 0) nonzero = true;
    }
    expect(nonzero).toBe(true);
  });
});

describe("Fme7Mapper (mapper 69)", () => {
  it("banks PRG/CHR via the command+parameter pair and sets mirroring", () => {
    const m = new Fme7Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 69 }));
    m.prgWrite(0x8000, 0x09); // command: PRG $8000
    m.prgWrite(0xa000, 2);
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xe000)).toBe(7); // fixed last
    m.prgWrite(0x8000, 0x00); // command: CHR window 0
    m.prgWrite(0xa000, 5);
    expect(m.chrRead(0x0000)).toBe(5);
    m.prgWrite(0x8000, 0x0c); // command: mirroring
    m.prgWrite(0xa000, 1);
    expect(m.mirroring()).toBe("horizontal");
  });
  it("fires the 16-bit IRQ on underflow only when both enables are set", () => {
    const m = new Fme7Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 69 }));
    m.prgWrite(0x8000, 0x0e); // IRQ low
    m.prgWrite(0xa000, 0x01);
    m.prgWrite(0x8000, 0x0f); // IRQ high
    m.prgWrite(0xa000, 0x00); // counter 0x0001
    m.prgWrite(0x8000, 0x0d); // IRQ control
    m.prgWrite(0xa000, 0x81); // counter enable (bit7) + IRQ enable (bit0)
    expect(m.irqState()).toBe(false);
    m.tick(2); // 1 → 0 → underflow asserts
    expect(m.irqState()).toBe(true);
  });
  it("emits 5B square-wave audio from a tone channel", () => {
    const m = new Fme7Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 69 }));
    const audio = m.audio()!;
    m.prgWrite(0xc000, 0x00); // select channel A period low
    m.prgWrite(0xe000, 0x02);
    m.prgWrite(0xc000, 0x07); // select enable register
    m.prgWrite(0xe000, 0x3e); // tone A enabled (bit 0 = 0), rest off
    m.prgWrite(0xc000, 0x08); // select channel A volume
    m.prgWrite(0xe000, 0x0f); // max volume
    let high = false;
    for (let i = 0; i < 2000; i++) {
      audio.clock();
      if (audio.output() > 0) high = true;
    }
    expect(high).toBe(true);
  });
});

describe("TxSromMapper (mapper 118)", () => {
  it("routes each nametable from bit 7 of the CHR bank that maps it", () => {
    const m = new TxSromMapper(rom({ prg16k: 8, chr8k: 8, mapper: 118 }));
    // CHR mode 0: R2-R5 map the four $1000-$1FFF quadrants → nametables 0-3.
    m.prgWrite(0x8000, 2); // command = R2
    m.prgWrite(0x8001, 0x80); // R2 bit 7 set → NT0 uses CIRAM 1
    m.prgWrite(0x8000, 3); // R3
    m.prgWrite(0x8001, 0x00); // NT1 uses CIRAM 0
    expect(m.nametable(0)).toBe(1);
    expect(m.nametable(1)).toBe(0);
  });
});

describe("Discrete mappers (93/94/97/180/184)", () => {
  it("93 Sunsoft-2 switches $8000 (bits 4-6), $C000 fixed last", () => {
    const m = new Sunsoft2Mapper(rom({ prg16k: 8, chrRam: true, mapper: 93 }));
    m.prgWrite(0x8000, 3 << 4);
    expect(m.prgRead(0x8000)).toBe(6); // 16 KiB bank 3 → 8 KiB marker 6
    expect(m.prgRead(0xc000)).toBe(14); // last
  });

  it("94 UN1ROM takes the PRG bank from bits 2-4", () => {
    const m = new Un1romMapper(rom({ prg16k: 8, chrRam: true, mapper: 94 }));
    m.prgWrite(0x8000, 3 << 2);
    expect(m.prgRead(0x8000)).toBe(6);
    expect(m.prgRead(0xc000)).toBe(14);
  });

  it("180 Nichibutsu fixes $8000 first, switches $C000", () => {
    const m = new Nichibutsu180Mapper(rom({ prg16k: 8, chrRam: true, mapper: 180 }));
    m.prgWrite(0x8000, 3);
    expect(m.prgRead(0x8000)).toBe(0); // fixed first
    expect(m.prgRead(0xc000)).toBe(6); // 16 KiB bank 3
  });

  it("97 Irem TAM-S1 fixes $8000 last, switches $C000, mirrors from bits 6-7", () => {
    const m = new IremTamS1Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 97 }));
    m.prgWrite(0x8000, 3 | (2 << 6));
    expect(m.prgRead(0x8000)).toBe(14); // fixed last
    expect(m.prgRead(0xc000)).toBe(6); // 16 KiB bank 3
    expect(m.mirroring()).toBe("horizontal");
  });

  it("184 Sunsoft-1 banks two 4 KiB CHR windows from a $6000 latch", () => {
    const m = new Sunsoft1Mapper(rom({ prg16k: 2, chr8k: 8, mapper: 184 })); // 16 x 4 KiB CHR
    m.lowWrite(0x6000, 0x21); // low nibble 1 → $0000; high nibble 2 → $1000, upper half (|0x08) = bank 10
    expect(m.chrRead(0x0000)).toBe(4); // 4 KiB bank 1 → 1 KiB marker 4
    expect(m.chrRead(0x1000)).toBe(40); // 4 KiB bank 10 → 1 KiB marker 40
  });
});

describe("BandaiFcgMapper (mapper 16)", () => {
  it("banks a 16 KiB PRG window at $8000, fixes the last at $C000, banks CHR", () => {
    const m = new BandaiFcgMapper(rom({ prg16k: 8, chr8k: 8, mapper: 16 }));
    m.prgWrite(0x8008, 3); // PRG bank 3 at $8000
    expect(m.prgRead(0x8000)).toBe(6); // 16 KiB bank 3 → 8 KiB marker 6
    expect(m.prgRead(0xc000)).toBe(14); // last 16 KiB bank 7 → marker 14
    m.prgWrite(0x8002, 9); // CHR bank at PPU $0800
    expect(m.chrRead(0x0800)).toBe(9);
    m.prgWrite(0x8009, 1);
    expect(m.mirroring()).toBe("horizontal");
  });

  it("counts the 16-bit CPU-cycle IRQ down from the latch", () => {
    const m = new BandaiFcgMapper(rom({ prg16k: 8, chr8k: 8, mapper: 16 }));
    m.prgWrite(0x800b, 0x03); // latch low
    m.prgWrite(0x800c, 0x00); // latch high → 0x0003
    m.prgWrite(0x800a, 1); // enable + reload counter from latch
    m.tick(2);
    expect(m.irqState()).toBe(false);
    m.tick(1); // 3 → 0
    expect(m.irqState()).toBe(false);
    m.tick(1); // 0 → underflow → assert
    expect(m.irqState()).toBe(true);
  });

  it("stores and reads back a byte through the serial EEPROM", () => {
    const m = new BandaiFcgMapper(rom({ prg16k: 8, chr8k: 8, mapper: 16, submapper: 5 }));
    const D = 0x800d;
    const set = (scl: number, sda: number) => m.prgWrite(D, (scl << 5) | (sda << 6));
    const start = () => {
      set(1, 1);
      set(1, 0); // SDA hi→lo while SCL high
    };
    const sendByte = (v: number) => {
      for (let i = 7; i >= 0; i--) {
        set(0, (v >> i) & 1);
        set(1, (v >> i) & 1);
      }
      set(0, 1); // ACK clock: release SDA, pulse SCL
      set(1, 1);
    };
    const readByte = () => {
      let v = 0;
      for (let i = 0; i < 8; i++) {
        set(0, 1);
        set(1, 1);
        v = (v << 1) | ((m.lowRead!(0x6000)! >> 4) & 1);
      }
      set(0, 1); // master NACK to end the read
      set(1, 1);
      return v;
    };
    // Write 0x5A to word address 0x10.
    start();
    sendByte(0xa0); // device address, write
    sendByte(0x10); // word address
    sendByte(0x5a); // data
    // Read it back (dummy write to set the address, then a read command).
    start();
    sendByte(0xa0);
    sendByte(0x10);
    start();
    sendByte(0xa1); // device address, read
    expect(readByte()).toBe(0x5a);
  });
});

describe("IremG101Mapper (mapper 32)", () => {
  it("swaps which of $8000/$C000 is switchable via the PRG-mode bit", () => {
    const m = new IremG101Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 32 })); // 16 x 8 KiB
    m.prgWrite(0x8000, 2); // PRG bank A
    m.prgWrite(0xa000, 5); // PRG bank B (always $A000)
    // Mode 0: $8000 = A, $C000 = penultimate.
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(5);
    expect(m.prgRead(0xc000)).toBe(14);
    expect(m.prgRead(0xe000)).toBe(15);
    // Mode 1 ($9000 bit 1): $8000 = penultimate, $C000 = A.
    m.prgWrite(0x9000, 0b10);
    expect(m.prgRead(0x8000)).toBe(14);
    expect(m.prgRead(0xc000)).toBe(2);
  });

  it("takes mirroring from $9000 bit 0 and banks CHR in 1 KiB via $B000-$B007", () => {
    const m = new IremG101Mapper(rom({ prg16k: 2, chr8k: 8, mapper: 32 }));
    m.prgWrite(0x9000, 1);
    expect(m.mirroring()).toBe("horizontal");
    m.prgWrite(0xb003, 9); // 1 KiB CHR bank at $0C00
    expect(m.chrRead(0x0c00)).toBe(9);
  });
});

describe("Simple Jaleco mappers (72/86/92/140)", () => {
  // The rom() helper marks 8 KiB PRG / 1 KiB CHR sub-banks, so a 16 KiB PRG bank
  // K reads back marker 2K and an 8 KiB CHR bank K reads back marker 8K.
  it("140 latches a 32 KiB PRG bank and 8 KiB CHR bank from $6000-$7FFF", () => {
    const m = new Jaleco140Mapper(rom({ prg16k: 8, chr8k: 4, mapper: 140 })); // 4 x 32 KiB PRG
    m.lowWrite(0x6000, 0x21); // PRG bits 4-5 = 2 (32 KiB bank 2), CHR bits 0-3 = 1
    expect(m.prgRead(0x8000)).toBe(8); // 32 KiB bank 2 → 16 KiB bank 4 → marker 8
    expect(m.prgRead(0xc000)).toBe(10); // 16 KiB bank 5 → marker 10
    expect(m.chrRead(0x0000)).toBe(8); // 8 KiB bank 1 → marker 8
  });

  it("86 takes the CHR bank from bits 0-1 + bit 6", () => {
    const m = new Jaleco86Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 86 }));
    m.lowWrite(0x6000, 0x42); // CHR = (2) | ((0x42>>4)&4 = 4) = 6
    expect(m.chrRead(0x0000)).toBe(48); // 8 KiB bank 6 → marker 48
  });

  it("72 switches the $8000 window; $C000 fixed last", () => {
    const m = new Jaleco72Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 72 })); // 8 x 16 KiB
    m.prgWrite(0x8000, 0x80 | 3); // bit 7 → PRG bank 3 at $8000
    m.prgWrite(0x8000, 0x40 | 5); // bit 6 → CHR bank 5
    expect(m.prgRead(0x8000)).toBe(6); // 16 KiB bank 3 → marker 6
    expect(m.prgRead(0xc000)).toBe(14); // last 16 KiB bank 7 → marker 14
    expect(m.chrRead(0x0000)).toBe(40); // 8 KiB bank 5 → marker 40
  });

  it("92 switches the $C000 window; $8000 fixed first", () => {
    const m = new Jaleco92Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 92 }));
    m.prgWrite(0x8000, 0x80 | 4); // bit 7 → PRG bank 4 at $C000
    expect(m.prgRead(0x8000)).toBe(0); // fixed first 16 KiB bank 0 → marker 0
    expect(m.prgRead(0xc000)).toBe(8); // 16 KiB bank 4 → marker 8
  });
});

describe("Namco 108 family (mappers 88/95/154/76)", () => {
  it("88 (DxROM) takes 1 KiB CHR banks from the upper 64 KiB", () => {
    const m = new Mapper88(rom({ prg16k: 4, chr8k: 16, mapper: 88 })); // 128 KiB CHR
    m.prgWrite(0x8000, 0); // command R0 (2 KiB bank at $0000)
    m.prgWrite(0x8001, 6);
    m.prgWrite(0x8000, 2); // command R2 (1 KiB bank at $1000)
    m.prgWrite(0x8001, 1);
    expect(m.chrRead(0x0000)).toBe(6); // 2 KiB bank stays in the low 64 KiB
    expect(m.chrRead(0x1000)).toBe(0x41); // 1 KiB bank 1 | 0x40 = upper half
  });

  it("95 (Dragon Buster) routes nametables from bit 5 of R0/R1", () => {
    const m = new Mapper95(rom({ prg16k: 4, chr8k: 8, mapper: 95 }));
    m.prgWrite(0x8000, 0); // R0
    m.prgWrite(0x8001, 0x20); // bit 5 set → NT0/1 use CIRAM 1
    m.prgWrite(0x8000, 1); // R1
    m.prgWrite(0x8001, 0x00); // NT2/3 use CIRAM 0
    expect(m.nametable(0)).toBe(1);
    expect(m.nametable(3)).toBe(0);
  });

  it("154 (Devil Man) switches one-screen mirroring from $8000 bit 6", () => {
    const m = new Mapper154(rom({ prg16k: 4, chr8k: 8, mapper: 154 }));
    m.prgWrite(0x8000, 0x40);
    expect(m.mirroring()).toBe("single-upper");
    m.prgWrite(0x8000, 0x00);
    expect(m.mirroring()).toBe("single-lower");
  });

  it("76 (Megami Tensei) banks CHR as four 2 KiB windows", () => {
    const m = new Mapper76(rom({ prg16k: 4, chr8k: 16, mapper: 76 }));
    m.prgWrite(0x8000, 4); // command = R4 (2 KiB window at $1000)
    m.prgWrite(0x8001, 3);
    expect(m.chrRead(0x1000)).toBe(6); // 2 KiB bank 3 → 1 KiB bank 6
    expect(m.chrRead(0x1400)).toBe(7);
  });
});

describe("TaitoTc0190Mapper (mapper 33)", () => {
  it("banks two switchable PRG windows with $C000/$E000 fixed, mirroring from $8000", () => {
    const m = new TaitoTc0190Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 33 })); // 16 x 8 KiB
    m.prgWrite(0x8000, 2 | 0x40); // PRG $8000 = bank 2, mirroring bit → horizontal
    m.prgWrite(0x8001, 5); // PRG $A000 = bank 5
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(5);
    expect(m.prgRead(0xc000)).toBe(14); // penultimate
    expect(m.prgRead(0xe000)).toBe(15); // last
    expect(m.mirroring()).toBe("horizontal");
  });

  it("banks CHR as two 2 KiB then four 1 KiB windows", () => {
    const m = new TaitoTc0190Mapper(rom({ prg16k: 2, chr8k: 8, mapper: 33 }));
    m.prgWrite(0x8002, 1); // 2 KiB bank at $0000 → 1 KiB banks 2,3
    m.prgWrite(0xa000, 9); // 1 KiB bank at $1000
    expect(m.chrRead(0x0000)).toBe(2);
    expect(m.chrRead(0x0400)).toBe(3);
    expect(m.chrRead(0x1000)).toBe(9);
  });
});

describe("Taito X1-005 / X1-017 (mappers 80/82)", () => {
  it("80 banks PRG via $7EFA-$7EFF ($E000 fixed), CHR 2 KiB (>>1) + 1 KiB, mirror $7EF6", () => {
    const m = new TaitoX1005Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 80 }));
    m.lowWrite(0x7efa, 2); // $8000 = 8 KiB bank 2
    m.lowWrite(0x7efc, 5); // $A000
    m.lowWrite(0x7efe, 9); // $C000
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(5);
    expect(m.prgRead(0xc000)).toBe(9);
    expect(m.prgRead(0xe000)).toBe(15); // fixed last
    m.lowWrite(0x7ef0, 4); // 2 KiB CHR: value >> 1 → 2 KiB bank 2 → 1 KiB bank 4
    m.lowWrite(0x7ef2, 9); // 1 KiB CHR at $1000
    expect(m.chrRead(0x0000)).toBe(4);
    expect(m.chrRead(0x1000)).toBe(9);
    m.lowWrite(0x7ef6, 1);
    expect(m.mirroring()).toBe("horizontal");
  });

  it("82 shifts the PRG bank values right by two", () => {
    const m = new TaitoX1017Mapper(rom({ prg16k: 8, chr8k: 8, mapper: 82 }));
    m.lowWrite(0x7efa, 2 << 2); // $8000 = 8 KiB bank 2
    m.lowWrite(0x7efb, 5 << 2); // $A000 = 8 KiB bank 5
    m.lowWrite(0x7efc, 6 << 2); // $C000 = 8 KiB bank 6
    expect(m.prgRead(0x8000)).toBe(2);
    expect(m.prgRead(0xa000)).toBe(5);
    expect(m.prgRead(0xc000)).toBe(6);
    expect(m.prgRead(0xe000)).toBe(15);
  });
});

describe("TaitoTc0690Mapper (mapper 48)", () => {
  it("takes mirroring from $E000 and runs an MMC3-style scanline IRQ", () => {
    const m = new TaitoTc0690Mapper(rom({ prg16k: 4, chr8k: 8, mapper: 48 }));
    m.prgWrite(0xe000, 0x40); // mirroring → horizontal (not $8000)
    expect(m.mirroring()).toBe("horizontal");
    m.prgWrite(0xc000, 2); // IRQ latch
    m.prgWrite(0xc001, 0); // reload
    m.prgWrite(0xc002, 0); // enable
    m.clockIrq(); // reload → 2
    m.clockIrq(); // 2 → 1
    expect(m.irqState()).toBe(false);
    m.clockIrq(); // 1 → 0 → assert
    expect(m.irqState()).toBe(true);
  });
});
