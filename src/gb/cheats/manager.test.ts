import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MMU } from "../memory/mmu.js";
import { type CheatEntry, CheatManager, newCheatId } from "./manager.js";

function gg(id: string, address: number, value: number, compare?: number, enabled = true): CheatEntry {
  return { id, name: id, code: id, format: "game-genie", enabled, address, value, compare };
}

function gs(id: string, address: number, value: number, enabled = true): CheatEntry {
  return { id, name: id, code: id, format: "game-shark", enabled, address, value };
}

describe("CheatManager", () => {
  let m: CheatManager;

  beforeEach(() => {
    m = new CheatManager();
  });

  describe("patchRomRead (Game Genie hot path)", () => {
    it("returns the original value when no cheats are registered", () => {
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0xab);
    });

    it("replaces the read value on an unconditional Game Genie patch", () => {
      m.add(gg("a", 0x1234, 0x99));
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0x99);
    });

    it("leaves unrelated addresses untouched", () => {
      m.add(gg("a", 0x1234, 0x99));
      expect(m.patchRomRead(0x1235, 0xab)).toBe(0xab);
    });

    it("honours the compare byte on a 9-digit code — mismatch returns original", () => {
      m.add(gg("a", 0x1234, 0x99, /* compare */ 0xab));
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0x99); // matches
      expect(m.patchRomRead(0x1234, 0x00)).toBe(0x00); // doesn't match → original
    });

    it("skips disabled entries", () => {
      m.add(gg("a", 0x1234, 0x99, undefined, /* enabled */ false));
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0xab);
    });
  });

  describe("applyRamWrites (Game Shark once-per-frame)", () => {
    it("writes each enabled Game Shark value once", () => {
      const writeByte = vi.fn();
      const mmu = { writeByte } as unknown as MMU;
      m.add(gs("a", 0xc000, 0x42));
      m.add(gs("b", 0xc100, 0x99));
      m.applyRamWrites(mmu);
      expect(writeByte).toHaveBeenCalledTimes(2);
      expect(writeByte).toHaveBeenCalledWith(0xc000, 0x42);
      expect(writeByte).toHaveBeenCalledWith(0xc100, 0x99);
    });

    it("skips Game Shark codes targeting ROM space — avoids triggering MBC bank switches", () => {
      const writeByte = vi.fn();
      const mmu = { writeByte } as unknown as MMU;
      m.add(gs("a", 0x4000, 0x42)); // ROM bank area
      m.applyRamWrites(mmu);
      expect(writeByte).not.toHaveBeenCalled();
    });

    it("does nothing when disabled", () => {
      const writeByte = vi.fn();
      const mmu = { writeByte } as unknown as MMU;
      m.add(gs("a", 0xc000, 0x42, /* enabled */ false));
      m.applyRamWrites(mmu);
      expect(writeByte).not.toHaveBeenCalled();
    });
  });

  describe("mutation API rebuilds hot-path maps", () => {
    it("setEnabled(false) immediately stops patching", () => {
      m.add(gg("a", 0x1234, 0x99));
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0x99);
      m.setEnabled("a", false);
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0xab);
    });

    it("remove() drops the entry from both hot-path maps", () => {
      m.add(gg("a", 0x1234, 0x99));
      m.remove("a");
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0xab);
    });

    it("clear() wipes everything", () => {
      m.add(gg("a", 0x1234, 0x99));
      m.add(gs("b", 0xc000, 0x42));
      m.clear();
      expect(m.entries).toEqual([]);
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0xab);
    });

    it("setEntries() replaces the whole list and deep-copies inputs", () => {
      const external: CheatEntry[] = [gg("a", 0x1234, 0x99)];
      m.setEntries(external);
      external[0]!.value = 0x00; // mutate caller's copy
      expect(m.patchRomRead(0x1234, 0xab)).toBe(0x99); // still uses the snapshot
    });
  });
});

describe("newCheatId", () => {
  it("returns a non-empty unique string each call", () => {
    const a = newCheatId();
    const b = newCheatId();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
