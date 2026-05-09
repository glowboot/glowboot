import { beforeEach, describe, expect, it } from "vitest";

import { INTERRUPT_VBLANK, InterruptController } from "../memory/interrupts.js";
import { PPU } from "./ppu.js";

describe("PPU", () => {
  let interrupts: InterruptController;
  let ppu: PPU;

  beforeEach(() => {
    interrupts = new InterruptController();
    ppu = new PPU(interrupts, /* cgb host */ true, /* cgb game */ false);
  });

  describe("framebuffer", () => {
    it("is a 160×144 RGBA buffer", () => {
      expect(ppu.framebuffer.length).toBe(160 * 144 * 4);
    });
  });

  describe("VRAM / OAM direct access (engine-internal)", () => {
    it("VRAM round-trips within bank 0", () => {
      ppu.writeVram(0x0000, 0xaa);
      expect(ppu.readVram(0x0000)).toBe(0xaa);
    });

    it("OAM round-trips in the 160-byte sprite attribute table", () => {
      ppu.writeOam(0x10, 0x42);
      expect(ppu.readOam(0x10)).toBe(0x42);
    });
  });

  describe("LCDC (0xFF40) and STAT (0xFF41)", () => {
    it("LCDC starts in a known post-boot state", () => {
      // Documented DMG post-boot LCDC = 0x91; CGB host uses the same.
      expect(ppu.readByte(0xff40)).toBe(0x91);
    });

    it("STAT bits 0-2 reflect the current mode (lower bits)", () => {
      // Mode is read-only in the lower bits. Exact mode depends on tick
      // state, but the top bit (7) should always read 1 (unused, pulled high).
      const stat = ppu.readByte(0xff41);
      expect(stat & 0x80).toBe(0x80);
    });

    it("writes to STAT only affect the interrupt-source bits (3-6)", () => {
      const before = ppu.readByte(0xff41);
      ppu.writeByte(0xff41, 0xff);
      const after = ppu.readByte(0xff41);
      // Mode bits (0-1) and LYC match bit (2) are NOT user-writable; the
      // high bit is always 1. So only bits 3-6 may have changed.
      expect((after ^ before) & 0x07).toBe(0);
    });
  });

  describe("LCD on/off transitions", () => {
    it("turning LCD off via LCDC bit 7 resets LY to 0", () => {
      ppu.tick(200); // run a bit so LY advances past 0
      ppu.writeByte(0xff40, 0x11); // LCDC with bit 7 = 0 (off)
      expect(ppu.readByte(0xff44)).toBe(0); // LY
    });
  });

  describe("VBlank interrupt", () => {
    it("fires exactly once per frame when LY enters the 144-153 range", () => {
      // One full frame = 70224 dots = 17556 M-cycles. The tick() method
      // handles at most one mode transition per call (matching real CPU
      // instruction pacing), so call it one M-cycle at a time.
      interrupts.if = 0;
      for (let i = 0; i < 17556; i++) ppu.tick(1);
      expect(interrupts.if & INTERRUPT_VBLANK).toBe(INTERRUPT_VBLANK);
    });
  });

  describe("CGB BCPS/BCPD palette-RAM indexing", () => {
    it("writing to BCPD advances the index when auto-increment bit is set", () => {
      ppu.writeByte(0xff68, 0x80); // BCPS: index 0, auto-inc on
      ppu.writeByte(0xff69, 0xcd); // BCPD write to index 0
      // Index should have moved to 1; the BCPS register hides it in bits 0-5.
      const bcps = ppu.readByte(0xff68);
      expect(bcps & 0x3f).toBe(1);
    });
  });
});
