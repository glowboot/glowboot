import { describe, expect, it } from "vitest";

import { InterruptController, IRQ_HBLANK, IRQ_VBLANK } from "./interrupts.js";
import { makeGbaMemoryMap } from "./mapped-bus.js";

describe("InterruptController — register I/O", () => {
  it("IE round-trips 14-bit values", () => {
    const ic = new InterruptController();
    ic.write16(0x00, 0x3fff);
    expect(ic.read16(0x00)).toBe(0x3fff);
    ic.write16(0x00, 0xffff); // upper bits beyond the 14-bit window are masked
    expect(ic.read16(0x00)).toBe(0x3fff);
  });

  it("IF reads pending bits and clears them write-1-to-clear", () => {
    const ic = new InterruptController();
    ic.raise(IRQ_VBLANK);
    ic.raise(IRQ_HBLANK);
    expect(ic.read16(0x02)).toBe(0b11);
    // Writing 1 to bit 0 clears VBlank, leaves HBlank.
    ic.write16(0x02, 0b01);
    expect(ic.read16(0x02)).toBe(0b10);
    // Writing 0 leaves a pending bit untouched.
    ic.write16(0x02, 0b00);
    expect(ic.read16(0x02)).toBe(0b10);
  });

  it("IME stores its 16-bit half; the unused 0x0A slot reads as 0 (mgba-suite io-read 'INVALID (20A)' expectation)", () => {
    const ic = new InterruptController();
    ic.write32(0x08, 0xdeadbeef);
    // 0x0A is unused on real hardware; writes are dropped and reads
    // return 0 regardless of what a 32-bit write put in its upper half.
    expect(ic.read16(0x08)).toBe(0xbeef);
    expect(ic.read16(0x0a)).toBe(0);
    // Read32 reads 0x208 (=IME, low half kept) + 0x20A (=0).
    expect(ic.read32(0x08)).toBe(0x0000beef | 0);
  });

  it("WAITCNT round-trips but has no behaviour", () => {
    const ic = new InterruptController();
    ic.write16(0x04, 0x4317);
    expect(ic.read16(0x04)).toBe(0x4317);
  });
});

describe("InterruptController — pending logic", () => {
  it("pending = false when IME bit 0 is clear", () => {
    const ic = new InterruptController();
    ic.ie = 0xffff;
    ic.if_ = 0xffff;
    ic.ime = 0;
    expect(ic.pending).toBe(false);
  });

  it("pending = false when IE & IF = 0", () => {
    const ic = new InterruptController();
    ic.ie = 1 << IRQ_VBLANK;
    ic.if_ = 1 << IRQ_HBLANK; // different sources — no overlap
    ic.ime = 1;
    expect(ic.pending).toBe(false);
  });

  it("pending = true when IME=1 and (IE & IF) ≠ 0", () => {
    const ic = new InterruptController();
    ic.ie = 1 << IRQ_VBLANK;
    ic.if_ = 1 << IRQ_VBLANK;
    ic.ime = 1;
    expect(ic.pending).toBe(true);
  });

  it("raise(source) sets the corresponding IF bit", () => {
    const ic = new InterruptController();
    ic.raise(IRQ_VBLANK);
    expect(ic.if_ & (1 << IRQ_VBLANK)).toBe(1 << IRQ_VBLANK);
    ic.raise(IRQ_HBLANK);
    expect(ic.if_).toBe((1 << IRQ_VBLANK) | (1 << IRQ_HBLANK));
  });
});

describe("MappedBus + InterruptController wiring", () => {
  it("CPU writes to 0x04000200 reach the IE register", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000200, 0x0001);
    expect(mem.interrupts.ie).toBe(0x0001);
  });

  it("CPU reads 0x04000208 return IME", () => {
    const mem = makeGbaMemoryMap();
    mem.interrupts.ime = 1;
    expect(mem.bus.read16(0x04000208)).toBe(1);
  });

  it("PPU VBlank transition raises IRQ_VBLANK when DISPSTAT.VBLANK_IRQ_ENABLE is set", () => {
    const mem = makeGbaMemoryMap();
    mem.ppu.dispstat = 1 << 3; // VBLANK_IRQ_ENABLE
    // Advance the PPU to the first VBlank line (vcount 160, dot 0).
    mem.ppu.tick(308 * 160);
    expect(mem.interrupts.if_ & (1 << IRQ_VBLANK)).toBe(1 << IRQ_VBLANK);
  });

  it("PPU VBlank transition does NOT raise IRQ_VBLANK when DISPSTAT.VBLANK_IRQ_ENABLE is clear", () => {
    const mem = makeGbaMemoryMap();
    mem.ppu.dispstat = 0; // disabled
    mem.ppu.tick(308 * 160);
    expect(mem.interrupts.if_ & (1 << IRQ_VBLANK)).toBe(0);
  });

  it("PPU HBlank transition raises IRQ_HBLANK when enabled", () => {
    const mem = makeGbaMemoryMap();
    mem.ppu.dispstat = 1 << 4; // HBLANK_IRQ_ENABLE
    // HBlank flag (and IRQ) fires at dot 252, not at draw end (240).
    // See HBLANK_FLAG_DOT doc — cycle 1006 of the 1232-cycle scanline.
    mem.ppu.tick(252);
    expect(mem.interrupts.if_ & (1 << IRQ_HBLANK)).toBe(1 << IRQ_HBLANK);
  });

  it("PPU VCount match raises IRQ_VCOUNT once on transition", () => {
    const mem = makeGbaMemoryMap();
    // Set VCount match target to line 50 + enable VCount IRQ.
    mem.ppu.dispstat = (50 << 8) | (1 << 5);
    mem.ppu.tick(308 * 50);
    expect(mem.interrupts.if_ & (1 << 2)).toBe(1 << 2);
    // Clear IF, advance through more scanlines (still on line 50, no
    // re-transition since the match bit is sticky for the line).
    mem.interrupts.if_ = 0;
    mem.ppu.tick(100);
    expect(mem.interrupts.if_ & (1 << 2)).toBe(0);
  });
});
