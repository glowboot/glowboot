import { describe, expect, it } from "vitest";

import { parseSnesRom } from "../cartridge/rom.js";
import { SnesBus } from "./bus.js";
import { SnesDma } from "./dma.js";

function makeBus(): SnesBus {
  const img = new Uint8Array(0x100000);
  for (let i = 0; i < img.length; i++) img[i] = (i * 31 + (i >> 11)) & 0xff;
  const h = 0x7fc0;
  const title = "DMA TEST".padEnd(21, " ");
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = 0x20;
  img[h + 0x16] = 0x02;
  img[h + 0x17] = 0x0a;
  img[h + 0x18] = 3;
  img[h + 0x19] = 0x01;
  img[h + 0x1c] = 0xaa;
  img[h + 0x1d] = 0xaa;
  img[h + 0x1e] = 0x55;
  img[h + 0x1f] = 0x55;
  img[h + 0x3c] = 0x00;
  img[h + 0x3d] = 0x80;
  return new SnesBus(parseSnesRom(img));
}

describe("SnesDma", () => {
  function setup(): { bus: SnesBus; dma: SnesDma; bWrites: [number, number][] } {
    const bus = makeBus();
    const dma = new SnesDma(bus);
    const bWrites: [number, number][] = [];
    bus.onIoRead = (addr) => (addr >= 0x2140 ? addr & 0xff : null);
    bus.onIoWrite = (addr, v) => bWrites.push([addr, v]);
    return { bus, dma, bWrites };
  }

  function config(dma: SnesDma, ch: number, regs: Record<number, number>): void {
    for (const [reg, v] of Object.entries(regs)) dma.writeReg(0x4300 | (ch << 4) | Number(reg), v);
  }

  it("mode 0 transfers A->B to a single register", () => {
    const { bus, dma, bWrites } = setup();
    bus.wram[0x100] = 0x11;
    bus.wram[0x101] = 0x22;
    bus.wram[0x102] = 0x33;
    config(dma, 0, { 0x0: 0x00, 0x1: 0x18, 0x2: 0x00, 0x3: 0x01, 0x4: 0x7e, 0x5: 3, 0x6: 0 });
    dma.run(0x01);
    expect(bWrites).toEqual([
      [0x2118, 0x11],
      [0x2118, 0x22],
      [0x2118, 0x33]
    ]);
  });

  it("mode 1 alternates two B-bus registers", () => {
    const { bus, dma, bWrites } = setup();
    for (let i = 0; i < 4; i++) bus.wram[0x200 + i] = 0xa0 + i;
    config(dma, 2, { 0x0: 0x01, 0x1: 0x18, 0x2: 0x00, 0x3: 0x02, 0x4: 0x7e, 0x5: 4, 0x6: 0 });
    dma.run(0x04);
    expect(bWrites).toEqual([
      [0x2118, 0xa0],
      [0x2119, 0xa1],
      [0x2118, 0xa2],
      [0x2119, 0xa3]
    ]);
  });

  it("transfers B->A when the direction bit is set", () => {
    const { bus, dma } = setup();
    config(dma, 0, { 0x0: 0x80, 0x1: 0x40, 0x2: 0x00, 0x3: 0x03, 0x4: 0x7e, 0x5: 2, 0x6: 0 });
    dma.run(0x01);
    expect(bus.wram[0x300]).toBe(0x40); // handler echoes reg low byte
    expect(bus.wram[0x301]).toBe(0x40);
  });

  it("honours fixed and decrementing A-bus steps", () => {
    const { bus, dma, bWrites } = setup();
    bus.wram[0x400] = 0x55;
    config(dma, 1, { 0x0: 0x08, 0x1: 0x22, 0x2: 0x00, 0x3: 0x04, 0x4: 0x7e, 0x5: 3, 0x6: 0 });
    dma.run(0x02);
    expect(bWrites).toEqual([
      [0x2122, 0x55],
      [0x2122, 0x55],
      [0x2122, 0x55]
    ]);
    bWrites.length = 0;
    bus.wram[0x500] = 1;
    bus.wram[0x4ff] = 2;
    config(dma, 1, { 0x0: 0x10, 0x1: 0x22, 0x2: 0x00, 0x3: 0x05, 0x4: 0x7e, 0x5: 2, 0x6: 0 });
    dma.run(0x02);
    expect(bWrites).toEqual([
      [0x2122, 1],
      [0x2122, 2]
    ]);
  });

  it("treats size 0 as 65536 bytes and leaves the counter at 0", () => {
    const { dma, bWrites } = setup();
    config(dma, 0, { 0x0: 0x00, 0x1: 0x18, 0x2: 0x00, 0x3: 0x00, 0x4: 0x7e, 0x5: 0, 0x6: 0 });
    dma.run(0x01);
    expect(bWrites.length).toBe(0x10000);
    expect(dma.readReg(0x4305)).toBe(0);
    expect(dma.readReg(0x4306)).toBe(0);
  });

  it("round-trips the register file", () => {
    const { dma } = setup();
    config(dma, 5, {
      0x0: 0x42,
      0x1: 0x18,
      0x2: 0x34,
      0x3: 0x12,
      0x4: 0x7e,
      0x5: 0xcd,
      0x6: 0xab,
      0x7: 0x40,
      0x8: 0x78,
      0x9: 0x56,
      0xa: 0x2f,
      0xb: 0x99
    });
    expect(dma.readReg(0x4350)).toBe(0x42);
    expect(dma.readReg(0x4352)).toBe(0x34);
    expect(dma.readReg(0x4353)).toBe(0x12);
    expect(dma.readReg(0x4355)).toBe(0xcd);
    expect(dma.readReg(0x4356)).toBe(0xab);
    expect(dma.readReg(0x435a)).toBe(0x2f);
    expect(dma.readReg(0x435b)).toBe(0x99);
    expect(dma.readReg(0x435f)).toBe(0x99);
  });
});

describe("SnesDma HDMA", () => {
  function hdmaSetup(): { bus: SnesBus; dma: SnesDma; bWrites: [number, number][] } {
    const bus = makeBus();
    const dma = new SnesDma(bus);
    const bWrites: [number, number][] = [];
    bus.onIoRead = () => null;
    bus.onIoWrite = (addr, v) => bWrites.push([addr, v]);
    return { bus, dma, bWrites };
  }

  it("runs a direct table: repeat entries transfer every line", () => {
    const { bus, dma, bWrites } = hdmaSetup();
    // table at 7E:1000 — $83 (repeat, 3 lines) with 3 data bytes, then end
    bus.wram[0x1000] = 0x83;
    bus.wram[0x1001] = 0x11;
    bus.wram[0x1002] = 0x22;
    bus.wram[0x1003] = 0x33;
    bus.wram[0x1004] = 0x00; // terminate
    dma.writeReg(0x4300, 0x00); // mode 0, direct
    dma.writeReg(0x4301, 0x32); // -> $2132
    dma.writeReg(0x4302, 0x00);
    dma.writeReg(0x4303, 0x10);
    dma.writeReg(0x4304, 0x7e);
    dma.hdmaEnabled = 0x01;
    dma.hdmaInit(); // line 0 setup + first transfer
    dma.hdmaRun(); // line 0
    dma.hdmaRun(); // line 1
    dma.hdmaRun(); // line 2
    dma.hdmaRun(); // line 3 (channel expires)
    expect(bWrites.slice(0, 3)).toEqual([
      [0x2132, 0x11],
      [0x2132, 0x22],
      [0x2132, 0x33]
    ]);
  });

  it("waits between transfers for non-repeat entries", () => {
    const { bus, dma, bWrites } = hdmaSetup();
    // $03 = transfer once, wait 3 lines; then $01 with new data; then end
    bus.wram[0x2000] = 0x03;
    bus.wram[0x2001] = 0xaa;
    bus.wram[0x2002] = 0x01;
    bus.wram[0x2003] = 0xbb;
    bus.wram[0x2004] = 0x00;
    dma.writeReg(0x4310, 0x00);
    dma.writeReg(0x4311, 0x21); // -> $2121
    dma.writeReg(0x4312, 0x00);
    dma.writeReg(0x4313, 0x20);
    dma.writeReg(0x4314, 0x7e);
    dma.hdmaEnabled = 0x02;
    dma.hdmaInit();
    for (let line = 0; line < 5; line++) dma.hdmaRun();
    expect(bWrites).toEqual([
      [0x2121, 0xaa], // line 0 (init transfer)
      [0x2121, 0xbb] // after the 3-line wait
    ]);
  });

  it("follows indirect tables through the DAS pointer", () => {
    const { bus, dma, bWrites } = hdmaSetup();
    // table: $82 (repeat 2 lines, indirect) -> pointer $3000; end
    bus.wram[0x2800] = 0x82;
    bus.wram[0x2801] = 0x00;
    bus.wram[0x2802] = 0x30;
    bus.wram[0x2803] = 0x00;
    bus.wram[0x3000] = 0x55;
    bus.wram[0x3001] = 0x66;
    dma.writeReg(0x4320, 0x40); // mode 0, indirect
    dma.writeReg(0x4321, 0x22);
    dma.writeReg(0x4322, 0x00);
    dma.writeReg(0x4323, 0x28);
    dma.writeReg(0x4324, 0x7e);
    dma.writeReg(0x4327, 0x7e); // indirect bank
    dma.hdmaEnabled = 0x04;
    dma.hdmaInit();
    dma.hdmaRun();
    dma.hdmaRun();
    expect(bWrites.slice(0, 2)).toEqual([
      [0x2122, 0x55],
      [0x2122, 0x66]
    ]);
  });
});
