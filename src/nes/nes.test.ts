import { describe, expect, it } from "vitest";

import { parseNesRom } from "./cartridge/rom.js";
import { Nes } from "./nes.js";

/** A minimal NROM image whose reset vector points at an infinite `JMP $8000`,
 *  so a frame completes without depending on a real game. */
function minimalNrom(): Uint8Array {
  const header = [0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const prg = new Uint8Array(0x4000);
  prg[0x0000] = 0x4c; // JMP $8000
  prg[0x0001] = 0x00;
  prg[0x0002] = 0x80;
  prg[0x3ffc] = 0x00; // reset vector → $8000
  prg[0x3ffd] = 0x80;
  const chr = new Uint8Array(0x2000);
  return new Uint8Array([...header, ...prg, ...chr]);
}

/** Wrap a 6502 program (placed at $8000) in a 16 KiB NROM image with the reset
 *  vector pointing at it. PRG-RAM ($6000-$7FFF) is observable through the public
 *  `cartridge.cpuRead`, so a program can publish results there for assertions. */
function programRom(prgBytes: readonly number[]): Uint8Array {
  const prg = new Uint8Array(0x4000);
  prg.set(prgBytes, 0);
  prg[0x3ffc] = 0x00; // reset vector → $8000
  prg[0x3ffd] = 0x80;
  const chr = new Uint8Array(0x2000);
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
  const rom = new Uint8Array(16 + prg.length + chr.length);
  rom.set(header, 0);
  rom.set(prg, 16);
  rom.set(chr, 16 + prg.length);
  return rom;
}

/**
 * Strobe $4016 (write 1 then 0) then read it `count` times, masking each read to
 * bit 0 (dropping the $40 open-bus high bits) and storing the bit at $6000+i:
 *
 *   LDA #$01 ; STA $4016   ; strobe high
 *   LDA #$00 ; STA $4016   ; strobe low → latch button state
 *   LDX #$00
 * loop:
 *   LDA $4016 ; AND #$01 ; STA $6000,X ; INX ; CPX #count ; BNE loop
 *   JMP forever
 */
function shiftOutRom(count: number): Uint8Array {
  return programRom([
    0xa9,
    0x01, // LDA #$01
    0x8d,
    0x16,
    0x40, // STA $4016
    0xa9,
    0x00, // LDA #$00
    0x8d,
    0x16,
    0x40, // STA $4016
    0xa2,
    0x00, // LDX #$00
    // loop ($800c):
    0xad,
    0x16,
    0x40, // LDA $4016
    0x29,
    0x01, // AND #$01
    0x9d,
    0x00,
    0x60, // STA $6000,X
    0xe8, // INX
    0xe0,
    count & 0xff, // CPX #count
    0xd0,
    0xf3, // BNE loop
    0x4c,
    0x19,
    0x80 // JMP $8019 (self)
  ]);
}

describe("Nes (browser-shell surface)", () => {
  it("fires onFrame once per runFrame with a 256×240 RGBA framebuffer", () => {
    const nes = new Nes(parseNesRom(minimalNrom()));
    let fired = 0;
    let fb: Uint8ClampedArray | null = null;
    nes.onFrame = (f) => {
      fired++;
      fb = f;
    };
    nes.runFrame();
    expect(fired).toBe(1);
    expect(fb).not.toBeNull();
    expect(fb!.length).toBe(256 * 240 * 4);
  });

  it("maps joypad presses to the $4016 shift-out bit order", () => {
    const nes = new Nes(parseNesRom(minimalNrom()));
    nes.joypad.press("a"); // bit 0
    nes.joypad.press("right"); // bit 7
    expect(nes.joypad.buttons).toBe(0x81);
    nes.joypad.release("a");
    expect(nes.joypad.buttons).toBe(0x80);
    nes.joypad.releaseAll();
    expect(nes.joypad.buttons).toBe(0);
  });

  it("runFrame returns the CPU cycles consumed, ~29780 for an NTSC frame", () => {
    const nes = new Nes(parseNesRom(minimalNrom()));
    const consumed = nes.runFrame();
    // An NTSC frame is 89342 PPU dots ÷ 3 ≈ 29780.5 CPU cycles; the exact count
    // depends on where the last instruction lands, so allow a small window.
    expect(consumed).toBeGreaterThan(29000);
    expect(consumed).toBeLessThan(30500);
  });

  it("accrues runFrame's return as the delta of cpu.cycles", () => {
    const nes = new Nes(parseNesRom(minimalNrom()));
    const before = nes.cpu.cycles;
    const consumed = nes.runFrame();
    expect(nes.cpu.cycles - before).toBe(consumed);
  });

  it("advances ppu.frame by one per runFrame while cpu.cycles keeps accruing", () => {
    const nes = new Nes(parseNesRom(minimalNrom()));
    expect(nes.ppu.frame).toBe(0);
    nes.runFrame();
    expect(nes.ppu.frame).toBe(1);
    const afterOne = nes.cpu.cycles;
    nes.runFrame();
    expect(nes.ppu.frame).toBe(2);
    expect(nes.cpu.cycles).toBeGreaterThan(afterOne);
  });

  it("clocks the PPU at three dots per CPU cycle", () => {
    const nes = new Nes(parseNesRom(minimalNrom()));
    // One full frame is 89342 dots = 3 × the per-frame CPU cycles (±1 frame's
    // worth of rounding from the odd-frame skipped dot and instruction landing).
    const consumed = nes.runFrame();
    const dots = consumed * 3;
    expect(dots).toBeGreaterThan(89000);
    expect(dots).toBeLessThan(90000);
  });
});

describe("Nes controller port ($4016)", () => {
  it("shifts out eight buttons in NesButton order after a strobe", () => {
    const nes = new Nes(parseNesRom(shiftOutRom(8)));
    nes.joypad.press("a"); // bit 0 → first out
    nes.joypad.press("right"); // bit 7 → eighth out
    nes.runFrame();
    const bits: number[] = [];
    for (let i = 0; i < 8; i++) bits.push(nes.cartridge.cpuRead(0x6000 + i));
    // order: a, b, select, start, up, down, left, right
    expect(bits).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("returns 1 for reads past the eighth (open-bus + shifted-in 1s)", () => {
    const nes = new Nes(parseNesRom(shiftOutRom(10)));
    // No buttons pressed: first eight reads are 0, the ninth onward read 1.
    nes.runFrame();
    const bits: number[] = [];
    for (let i = 0; i < 10; i++) bits.push(nes.cartridge.cpuRead(0x6000 + i));
    expect(bits).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  });
});

describe("Nes cheats hook", () => {
  // Program: `LDA #$11; STA $6000; JMP $8000` — pins PRG-RAM $6000 to 0x11 every
  // loop. PRG-RAM is publicly readable via cartridge.cpuRead.
  const rewriteRom = () => programRom([0xa9, 0x11, 0x8d, 0x00, 0x60, 0x4c, 0x00, 0x80]);

  it("leaves PRG-RAM at the program's value when no cheat is active", () => {
    const nes = new Nes(parseNesRom(rewriteRom()));
    nes.runFrame();
    expect(nes.cartridge.cpuRead(0x6000)).toBe(0x11);
  });

  it("re-freezes a RAM cheat once per runFrame so the value sticks", () => {
    const nes = new Nes(parseNesRom(rewriteRom()));
    nes.cheats.setEntries([
      {
        id: "freeze",
        name: "freeze $6000",
        code: "6000:55",
        format: "game-shark",
        enabled: true,
        address: 0x6000,
        value: 0x55
      }
    ]);
    nes.runFrame();
    // The program writes 0x11 every loop; the end-of-frame cheat hook overrides
    // it back to 0x55.
    expect(nes.cartridge.cpuRead(0x6000)).toBe(0x55);
  });
});
