import { describe, expect, it } from "vitest";

import { Sa1 } from "./sa1.js";

function makeSa1(romSize = 0x100000): { sa1: Sa1; rom: Uint8Array; bwram: Uint8Array } {
  const rom = new Uint8Array(romSize);
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 7 + (i >> 12)) & 0xff;
  const bwram = new Uint8Array(0x8000);
  const sa1 = new Sa1(rom, bwram, false);
  return { sa1, rom, bwram };
}

/** Drive an S-CPU-side register write. */
function ioWrite(sa1: Sa1, reg: number, value: number): void {
  sa1.writeCpu(0x00, reg, value);
}

/** SA-1-side register access goes through the chip's own bus. */
function sa1Write(sa1: Sa1, reg: number, value: number): void {
  sa1.writeSa1Bus(reg, value);
}

function sa1Read(sa1: Sa1, reg: number): number {
  return sa1.readSa1Bus(reg);
}

describe("SA-1 coprocessor", () => {
  it("multiplies signed 16x16 into the 32-bit result registers", () => {
    const { sa1 } = makeSa1();
    sa1Write(sa1, 0x2250, 0x00); // multiply mode
    sa1Write(sa1, 0x2251, 0xe8); // MA = $E8E8 = -5912
    sa1Write(sa1, 0x2252, 0xe8);
    sa1Write(sa1, 0x2253, 0x39); // MB = 12345 -> triggers
    sa1Write(sa1, 0x2254, 0x30);
    const mr =
      sa1Read(sa1, 0x2306) | (sa1Read(sa1, 0x2307) << 8) | (sa1Read(sa1, 0x2308) << 16) | (sa1Read(sa1, 0x2309) << 24);
    expect(mr >> 0).toBe(-5912 * 12345);
  });

  it("divides with floor rounding (signed dividend, unsigned divisor)", () => {
    const { sa1 } = makeSa1();
    sa1Write(sa1, 0x2250, 0x01); // divide mode
    sa1Write(sa1, 0x2251, 0xf8); // MA = -8 (0xfff8)
    sa1Write(sa1, 0x2252, 0xff);
    sa1Write(sa1, 0x2253, 0x03); // MB = 3 -> triggers
    sa1Write(sa1, 0x2254, 0x00);
    const quotient = sa1Read(sa1, 0x2306) | (sa1Read(sa1, 0x2307) << 8);
    const remainder = sa1Read(sa1, 0x2308) | (sa1Read(sa1, 0x2309) << 8);
    // -8 / 3 rounds toward negative infinity: -3 remainder 1
    expect(((quotient << 16) >> 16) | 0).toBe(-3);
    expect(remainder).toBe(1);
  });

  it("accumulates 40-bit cumulative sums with an overflow flag", () => {
    const { sa1 } = makeSa1();
    sa1Write(sa1, 0x2250, 0x02); // sigma mode (also clears MR)
    for (let i = 0; i < 3; i++) {
      sa1Write(sa1, 0x2251, 0x10); // MA = 0x0010
      sa1Write(sa1, 0x2252, 0x00);
      sa1Write(sa1, 0x2253, 0x00); // MB = 0x0100 -> accumulate
      sa1Write(sa1, 0x2254, 0x01);
    }
    const mr = sa1Read(sa1, 0x2306) | (sa1Read(sa1, 0x2307) << 8) | (sa1Read(sa1, 0x2308) << 16);
    expect(mr).toBe(3 * 0x10 * 0x100);
    expect(sa1Read(sa1, 0x230b)).toBe(0);
  });

  it("maps ROM through the Super MMC bank registers", () => {
    const { sa1, rom } = makeSa1(0x800000); // 8 MiB image, 8 MMC pages
    // Default chunk C mirrors the image linearly: $00:8000 = image offset 0.
    expect(sa1.romReadCpu(0x00, 0x8000)).toBe(rom[0]!);
    // Point bank C at MMC page 5 and read through the same window.
    ioWrite(sa1, 0x2220, 0x85);
    expect(sa1.romReadCpu(0x00, 0x8000)).toBe(rom[5 << 20]!);
    // $C0-banks read the same chunk linearly.
    expect(sa1.readCpu(0xc0, 0x0000)).toBe(rom[5 << 20]!);
  });

  it("gates I-RAM writes on the per-256-byte protection masks", () => {
    const { sa1 } = makeSa1();
    // S-CPU side: SIWP all clear blocks writes to $3000-$37FF.
    expect(sa1.writeCpu(0x00, 0x3000, 0xaa)).toBe(true);
    expect(sa1.readCpu(0x00, 0x3000)).toBe(0x00);
    ioWrite(sa1, 0x2229, 0x01); // allow the first 256-byte block
    sa1.writeCpu(0x00, 0x3000, 0xaa);
    expect(sa1.readCpu(0x00, 0x3000)).toBe(0xaa);
    // SA-1 side: CIWP gates $0000-$07FF the same way.
    sa1Write(sa1, 0x0100, 0x55);
    expect(sa1Read(sa1, 0x0100)).toBe(0x00);
    sa1Write(sa1, 0x222a, 0x02); // second block
    sa1Write(sa1, 0x0100, 0x55);
    expect(sa1Read(sa1, 0x0100)).toBe(0x55);
  });

  it("raises the S-CPU IRQ line through the SCNT/SIE mailbox", () => {
    const { sa1 } = makeSa1();
    let irqSignals = 0;
    sa1.onSnesIrq = () => irqSignals++;
    ioWrite(sa1, 0x2201, 0x80); // SIE: enable SA-1 -> S-CPU IRQ
    expect(sa1.snesIrqAsserted()).toBe(false);
    sa1Write(sa1, 0x2209, 0x80); // SCNT: assert IRQ
    expect(sa1.snesIrqAsserted()).toBe(true);
    expect(irqSignals).toBe(1);
    // S-CPU reads SFR: IRQ flag visible in bit 7.
    expect(sa1.readCpu(0x00, 0x2300)! & 0x80).toBe(0x80);
    // Acknowledge via SIC.
    ioWrite(sa1, 0x2202, 0x80);
    expect(sa1.snesIrqAsserted()).toBe(false);
  });

  it("boots the SA-1 core at CRV when reset is released", () => {
    const { sa1 } = makeSa1();
    ioWrite(sa1, 0x2203, 0x34);
    ioWrite(sa1, 0x2204, 0x12); // CRV = $1234
    ioWrite(sa1, 0x2200, 0x00); // release reset
    expect(sa1.cpu.pc).toBe(0x1234);
    expect(sa1.cpu.pbr).toBe(0);
  });

  it("transfers normal DMA from ROM to I-RAM", () => {
    const { sa1, rom } = makeSa1();
    sa1Write(sa1, 0x222a, 0xff); // open I-RAM for the DMA writes
    sa1Write(sa1, 0x2230, 0x80); // DMA on, source ROM, dest I-RAM
    sa1Write(sa1, 0x2238, 0x10); // 16 bytes
    sa1Write(sa1, 0x2239, 0x00);
    sa1Write(sa1, 0x2232, 0x00); // DSA = $00:8000 (image offset 0)
    sa1Write(sa1, 0x2233, 0x80);
    sa1Write(sa1, 0x2234, 0x00);
    sa1Write(sa1, 0x2235, 0x00); // DDA = I-RAM 0 -> triggers on mid byte
    sa1Write(sa1, 0x2236, 0x00);
    for (let i = 0; i < 16; i++) expect(sa1.iram[i]).toBe(rom[i]);
  });

  it("reads and writes the BW-RAM bitmap projections", () => {
    const { sa1, bwram } = makeSa1();
    sa1Write(sa1, 0x2227, 0x80); // CWEN: SA-1 writes enabled
    sa1Write(sa1, 0x223f, 0x00); // 4bpp
    // $60-$6F bitmap space: two 4-bit pixels per byte.
    sa1Write(sa1, 0x600000, 0x0c);
    sa1Write(sa1, 0x600001, 0x03);
    expect(bwram[0]).toBe(0x3c);
    expect(sa1Read(sa1, 0x600000)).toBe(0x0c);
    expect(sa1Read(sa1, 0x600001)).toBe(0x03);
  });

  it("reads variable-length bit strings from ROM", () => {
    const { sa1, rom } = makeSa1();
    // VDA -> image offset 0 via the $C0 linear view.
    sa1Write(sa1, 0x2259, 0x00);
    sa1Write(sa1, 0x225a, 0x00);
    sa1Write(sa1, 0x225b, 0xc0);
    const expected = (rom[0]! | (rom[1]! << 8)) & 0xffff;
    const got = sa1Read(sa1, 0x230c) | (sa1Read(sa1, 0x230d) << 8);
    expect(got).toBe(expected);
  });
});
