import { describe, expect, it } from "vitest";

import { Snes } from "./snes.js";

/** Build a bootable LoROM image: `program` at $00:8000, reset vector set. */
function makeSnes(program: number[]): Snes {
  const img = new Uint8Array(0x80000);
  img.set(program, 0);
  const h = 0x7fc0;
  const title = "SYSTEM TEST".padEnd(21, " ");
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = 0x20;
  img[h + 0x17] = 0x09;
  img[h + 0x19] = 0x01;
  img[h + 0x1c] = 0xaa;
  img[h + 0x1d] = 0xaa;
  img[h + 0x1e] = 0x55;
  img[h + 0x1f] = 0x55;
  img[h + 0x3c] = 0x00; // reset -> $8000
  img[h + 0x3d] = 0x80;
  return new Snes(img);
}

const STP = 0xdb;

describe("Snes system", () => {
  it("boots from the reset vector and runs cartridge code", () => {
    // LDA #$42; STA $7E2000; STP
    const snes = makeSnes([0xa9, 0x42, 0x8f, 0x00, 0x20, 0x7e, STP]);
    snes.runFrame();
    expect(snes.bus.wram[0x2000]).toBe(0x42);
    expect(snes.cpu.stopped).toBe(true);
  });

  it("delivers the VBlank NMI through the emulation vector when enabled", () => {
    // Enable NMI ($4200 = $80), then loop. NMI handler at $9000 increments
    // WRAM $10 and returns; vector at $FFFA.
    const program = new Array<number>(0x1100).fill(0xea);
    program.splice(0, 5, 0xa9, 0x80, 0x8d, 0x00, 0x42); // LDA #$80; STA $4200
    program[5] = 0x4c; // JMP $8005 (spin)
    program[6] = 0x05;
    program[7] = 0x80;
    program.splice(0x1000, 4, 0xee, 0x10, 0x00, 0x40); // INC $0010; RTI
    const snes = makeSnes(program);
    // emulation NMI vector -> $9000
    const romOff = 0x7ffa;
    (snes.rom.rom as Uint8Array)[romOff] = 0x00;
    (snes.rom.rom as Uint8Array)[romOff + 1] = 0x90;
    snes.runFrame();
    snes.runFrame();
    expect(snes.bus.wram[0x10]).toBeGreaterThanOrEqual(1);
    expect(snes.bus.wram[0x10]).toBeLessThanOrEqual(3);
  });

  it("computes hardware multiply and divide results", () => {
    // $4202=$12, $4203=$34 -> RDMPY=$3A8; then $4204/5=1000, $4206=7
    const snes = makeSnes([
      0xa9,
      0x12,
      0x8d,
      0x02,
      0x42,
      0xa9,
      0x34,
      0x8d,
      0x03,
      0x42,
      0xad,
      0x16,
      0x42,
      0x8f,
      0x00,
      0x10,
      0x7e,
      0xad,
      0x17,
      0x42,
      0x8f,
      0x01,
      0x10,
      0x7e,
      0xa9,
      0xe8,
      0x8d,
      0x04,
      0x42,
      0xa9,
      0x03,
      0x8d,
      0x05,
      0x42,
      0xa9,
      0x07,
      0x8d,
      0x06,
      0x42,
      0xad,
      0x14,
      0x42,
      0x8f,
      0x02,
      0x10,
      0x7e,
      0xad,
      0x16,
      0x42,
      0x8f,
      0x03,
      0x10,
      0x7e,
      STP
    ]);
    snes.runFrame();
    expect(snes.bus.wram[0x1000]! | (snes.bus.wram[0x1001]! << 8)).toBe(0x12 * 0x34);
    expect(snes.bus.wram[0x1002]).toBe(Math.floor(1000 / 7) & 0xff);
    expect(snes.bus.wram[0x1003]).toBe(1000 % 7);
  });

  it("latches auto-joypad state at VBlank", () => {
    // Enable auto-joy + NMI wait loop reading $4218 into WRAM.
    const snes = makeSnes([
      0xa9,
      0x01,
      0x8d,
      0x00,
      0x42, // STA $4200 (auto-joy)
      0xad,
      0x18,
      0x42,
      0x8f,
      0x00,
      0x30,
      0x7e, // read joy low -> $7E3000
      0x4c,
      0x05,
      0x80 // spin re-reading
    ]);
    snes.buttons1 = 0x8000 | 0x0080; // B + A-region bit
    snes.runFrame();
    snes.runFrame();
    expect(snes.bus.wram[0x3000]).toBe(snes.buttons1 & 0xff);
  });

  it("exposes the S-SMP IPL announce on the APU ports", () => {
    // Poll for the $AA announce like real games do — the boot loader
    // spends its init (zero-page clear) before driving the ports.
    const snes = makeSnes([
      0xad,
      0x40,
      0x21,
      0xc9,
      0xaa,
      0xd0,
      0xf9, // wait: LDA $2140 / CMP #$AA / BNE
      0x8f,
      0x00,
      0x40,
      0x7e, // STA $7E4000
      0xad,
      0x41,
      0x21,
      0x8f,
      0x01,
      0x40,
      0x7e, // read $2141 -> $7E4001
      0xa9,
      0x77,
      0x8d,
      0x42,
      0x21, // write $77 to $2142
      STP
    ]);
    snes.runFrame();
    snes.runFrame();
    expect(snes.bus.wram[0x4000]).toBe(0xaa);
    expect(snes.bus.wram[0x4001]).toBe(0xbb);
    expect(snes.apu.portsToSpc[2]).toBe(0x77);
  });

  it("runs a general DMA fired via $420B", () => {
    // DMA channel 0: WRAM $7E5000 -> $2122 (CGRAM), 2 bytes.
    const snes = makeSnes([
      0xa9,
      0x11,
      0x8f,
      0x00,
      0x50,
      0x7e,
      0xa9,
      0x7c,
      0x8f,
      0x01,
      0x50,
      0x7e, // colour $7C11
      0xa9,
      0x00,
      0x8d,
      0x21,
      0x21, // CGADD = 0
      0xa9,
      0x00,
      0x8d,
      0x00,
      0x43, // DMAP0 mode 0
      0xa9,
      0x22,
      0x8d,
      0x01,
      0x43, // B addr $2122
      0xa9,
      0x00,
      0x8d,
      0x02,
      0x43,
      0xa9,
      0x50,
      0x8d,
      0x03,
      0x43,
      0xa9,
      0x7e,
      0x8d,
      0x04,
      0x43,
      0xa9,
      0x02,
      0x8d,
      0x05,
      0x43,
      0xa9,
      0x00,
      0x8d,
      0x06,
      0x43, // size 2
      0xa9,
      0x01,
      0x8d,
      0x0b,
      0x42, // MDMAEN ch0
      STP
    ]);
    snes.runFrame();
    expect(snes.ppu.cgram[0]).toBe(0x11);
    expect(snes.ppu.cgram[1]).toBe(0x7c);
  });
});

describe("Snes PAL region", () => {
  it("derives PAL timing from the cartridge country code", () => {
    const img = new Uint8Array(0x80000);
    const h = 0x7fc0;
    const title = "PAL REGION TEST".padEnd(21, " ");
    for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
    img[h + 0x15] = 0x20;
    img[h + 0x17] = 0x09;
    img[h + 0x19] = 0x09; // Germany
    img[h + 0x1c] = 0xaa;
    img[h + 0x1d] = 0xaa;
    img[h + 0x1e] = 0x55;
    img[h + 0x1f] = 0x55;
    img[h + 0x3c] = 0x00;
    img[h + 0x3d] = 0x80;
    img[0] = 0xdb; // STP
    const snes = new Snes(img);
    expect(snes.rom.region).toBe("pal");
    expect(snes.ppu.totalLines).toBe(312);
    expect(snes.framesPerSec).toBeCloseTo(50.007);
  });
});

describe("Snes cheats", () => {
  it("applies Game Genie ROM patches and PAR RAM freezes end-to-end", () => {
    const snes = makeSnes([STP]);
    // GG "C86D-DDFD" patches bus $018000 (LoROM: rom offset $8000) to $AB.
    snes.cheats.add({
      id: "t1",
      name: "gg",
      code: "C86D-DDFD",
      format: "game-genie",
      enabled: true,
      address: 0x018000,
      value: 0xab
    });
    expect(snes.bus.read(0x018000)).toBe(0xab);
    expect(snes.bus.read(0x818000)).toBe(0xab); // fast mirror shares the patch

    // PAR freeze: WRAM $7E0040 pinned to $7F every frame.
    snes.cheats.add({
      id: "t2",
      name: "par",
      code: "7E00407F",
      format: "pro-action-replay",
      enabled: true,
      address: 0x7e0040,
      value: 0x7f
    });
    snes.runFrame();
    expect(snes.bus.wram[0x40]).toBe(0x7f);
    snes.bus.wram[0x40] = 0; // game overwrites...
    snes.runFrame();
    expect(snes.bus.wram[0x40]).toBe(0x7f); // ...freeze re-applies
  });
});

describe("Snes H/V IRQ dot timing", () => {
  it("fires the H-IRQ at the HTIME dot, not at line start", () => {
    // Program: enable H+V IRQ at (H=100, V=2), CLI, then spin. The IRQ
    // handler (vector at $80F0) stores the latched H-counter to WRAM.
    const img = new Uint8Array(0x80000);
    const prog = [
      0xa9,
      0x64,
      0x8d,
      0x07,
      0x42, // HTIME = 100
      0xa9,
      0x00,
      0x8d,
      0x08,
      0x42,
      0xa9,
      0x02,
      0x8d,
      0x09,
      0x42, // VTIME = 2
      0xa9,
      0x00,
      0x8d,
      0x0a,
      0x42,
      0xa9,
      0x30,
      0x8d,
      0x00,
      0x42, // NMITIMEN: H+V IRQ
      0x58, // CLI
      0x80,
      0xfe // BRA * (wait for IRQ)
    ];
    img.set(prog, 0);
    // IRQ handler at $80F0: latch counters, store OPHCT low to $7E1000, ack, STP
    img.set([0xad, 0x37, 0x21, 0xad, 0x3c, 0x21, 0x8f, 0x00, 0x10, 0x7e, 0xad, 0x11, 0x42, 0xdb], 0xf0);
    const h = 0x7fc0;
    for (let i = 0; i < 21; i++) img[h + i] = 32;
    img[h + 0x15] = 0x20;
    img[h + 0x17] = 0x09;
    img[h + 0x19] = 0x01;
    img[h + 0x1c] = 0xaa;
    img[h + 0x1d] = 0xaa;
    img[h + 0x1e] = 0x55;
    img[h + 0x1f] = 0x55;
    img[h + 0x3c] = 0x00;
    img[h + 0x3d] = 0x80;
    img[h + 0x3e] = 0xf0; // emulation IRQ/BRK vector -> $80F0
    img[h + 0x3f] = 0x80;
    const snes = new Snes(img);
    for (let i = 0; i < 4 && !snes.cpu.stopped; i++) snes.runFrame();
    expect(snes.cpu.stopped).toBe(true);
    const hLow = snes.bus.wram[0x1000]!;
    // Latched H counter should sit at/just past dot 100 plus the handler's
    // entry latency — decisively past 100 and decisively before 339.
    expect(hLow).toBeGreaterThanOrEqual(100);
    expect(hLow).toBeLessThan(180);
  });
});
