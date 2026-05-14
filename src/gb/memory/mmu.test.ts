import { beforeEach, describe, expect, it } from "vitest";

import { APU } from "../apu/apu.js";
import type { Cartridge } from "../cartridge/cartridge.js";
import { Joypad } from "../joypad/joypad.js";
import { PPU } from "../ppu/ppu.js";
import { Timer } from "../timer/timer.js";
import { InterruptController } from "./interrupts.js";
import { MMU } from "./mmu.js";

/**
 * Minimal cartridge stub — the full Cartridge constructor needs a valid
 * Nintendo-logo fingerprint which we deliberately don't embed. For MMU
 * tests we only need an object that responds to read/write in the ROM
 * and external-RAM ranges.
 */
function makeFakeCart(): Cartridge {
  const ram = new Uint8Array(0x2000);
  return {
    read: (addr: number) => {
      if (addr >= 0xa000 && addr < 0xc000) return ram[addr - 0xa000]!;
      return 0xff; // ROM area reads as 0xFF (empty stub)
    },
    write: (addr: number, v: number) => {
      if (addr >= 0xa000 && addr < 0xc000) ram[addr - 0xa000] = v & 0xff;
    },
    ram,
    rom: new Uint8Array(0x8000),
    hasBattery: false,
    ramDirty: false,
    clearDirty: () => undefined,
    tickRtc: () => undefined
  } as unknown as Cartridge;
}

function makeMmu(cgb = true): MMU {
  const interrupts = new InterruptController();
  const ppu = new PPU(interrupts, cgb, false);
  const apu = new APU();
  const timer = new Timer(interrupts);
  const joypad = new Joypad(interrupts);
  return new MMU(makeFakeCart(), ppu, apu, timer, joypad, interrupts, cgb);
}

describe("MMU address routing", () => {
  let mmu: MMU;

  beforeEach(() => {
    mmu = makeMmu();
  });

  describe("Work RAM (0xC000-0xDFFF)", () => {
    it("round-trips bytes in the fixed bank 0 region", () => {
      mmu.writeByte(0xc100, 0xab);
      expect(mmu.readByte(0xc100)).toBe(0xab);
    });

    it("round-trips bytes in the switchable bank region (D000-DFFF)", () => {
      mmu.writeByte(0xd200, 0xcd);
      expect(mmu.readByte(0xd200)).toBe(0xcd);
    });
  });

  describe("Echo RAM (0xE000-0xFDFF)", () => {
    it("reads mirror WRAM 0xC000-0xDDFF", () => {
      mmu.writeByte(0xc100, 0x42);
      expect(mmu.readByte(0xe100)).toBe(0x42);
    });

    it("writes also go to the mirrored WRAM address", () => {
      mmu.writeByte(0xe200, 0x33);
      expect(mmu.readByte(0xc200)).toBe(0x33);
    });
  });

  describe("HRAM + IE (0xFF80-0xFFFF)", () => {
    it("HRAM round-trips", () => {
      mmu.writeByte(0xff80, 0xaa);
      mmu.writeByte(0xfffe, 0xbb);
      expect(mmu.readByte(0xff80)).toBe(0xaa);
      expect(mmu.readByte(0xfffe)).toBe(0xbb);
    });

    it("IE register at 0xFFFF is directly accessible", () => {
      mmu.writeByte(0xffff, 0x1f);
      expect(mmu.readByte(0xffff)).toBe(0x1f);
    });
  });

  describe("Prohibited region (0xFEA0-0xFEFF)", () => {
    it("writes are dropped, reads return 0xFF", () => {
      mmu.writeByte(0xfea0, 0x42);
      expect(mmu.readByte(0xfea0)).toBe(0xff);
    });
  });

  describe("External RAM (0xA000-0xBFFF)", () => {
    it("forwards to the cartridge's write method", () => {
      mmu.writeByte(0xa000, 0x77);
      expect(mmu.readByte(0xa000)).toBe(0x77);
    });
  });

  describe("CGB WRAM bank switching via SVBK (0xFF70)", () => {
    it("bank 0 stays mapped at 0xC000 regardless of SVBK", () => {
      mmu.writeByte(0xc000, 0xaa);
      mmu.writeByte(0xff70, 0x05); // switch to bank 5
      expect(mmu.readByte(0xc000)).toBe(0xaa); // unchanged
    });

    it("bank 0 and bank 5 at 0xD000 hold different values", () => {
      mmu.writeByte(0xff70, 0x01); // bank 1
      mmu.writeByte(0xd100, 0x11);
      mmu.writeByte(0xff70, 0x05); // bank 5
      mmu.writeByte(0xd100, 0x55);
      expect(mmu.readByte(0xd100)).toBe(0x55);
      mmu.writeByte(0xff70, 0x01);
      expect(mmu.readByte(0xd100)).toBe(0x11);
    });
  });

  describe("CGB GP-DMA auto-advance (X-Men Mutant Academy regression)", () => {
    it("re-triggering GP-DMA after only updating the source writes to the advanced destination", () => {
      // Fill WRAM with a pattern. WRAM (0xC000+) is in the legal HDMA
      // source range and is writable from the test, unlike ROM.
      for (let i = 0; i < 48; i++) mmu.writeByte(0xc000 + i, 0x10 + i);

      // Initial setup: src = 0xC000, dst = 0x8000.
      mmu.writeByte(0xff51, 0xc0);
      mmu.writeByte(0xff52, 0x00);
      mmu.writeByte(0xff53, 0x00);
      mmu.writeByte(0xff54, 0x00);

      // Three back-to-back GP-DMAs of 1 block each, only updating the
      // source between calls. With auto-advance, the destination walks
      // forward 16 bytes per block; without it, every block clobbers
      // 0x8000-0x800F and the rest of VRAM stays untouched.
      mmu.writeByte(0xff55, 0x00); // block 1 → 0x8000
      mmu.writeByte(0xff52, 0x10); // src = 0xC010
      mmu.writeByte(0xff55, 0x00); // block 2 → 0x8010 (auto-advanced)
      mmu.writeByte(0xff52, 0x20); // src = 0xC020
      mmu.writeByte(0xff55, 0x00); // block 3 → 0x8020

      for (let i = 0; i < 48; i++) {
        expect(mmu.readByte(0x8000 + i)).toBe(0x10 + i);
      }
    });

    it("FF53 / FF54 read back at the advanced destination after a GP-DMA completes", () => {
      for (let i = 0; i < 32; i++) mmu.writeByte(0xc000 + i, i);
      mmu.writeByte(0xff51, 0xc0);
      mmu.writeByte(0xff52, 0x00);
      mmu.writeByte(0xff53, 0x00);
      mmu.writeByte(0xff54, 0x00);
      mmu.writeByte(0xff55, 0x01); // 2 blocks = 32 bytes

      // Destination should now point past 0x8020 (= 0x8000 + 32).
      expect(mmu.readByte(0xff53)).toBe(0x00);
      expect(mmu.readByte(0xff54)).toBe(0x20);
    });
  });
});
