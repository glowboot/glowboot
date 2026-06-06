import { beforeEach, describe, expect, it } from "vitest";

import {
  addGbaPcBreakpoint,
  addGbaReadWatchpoint,
  addGbaWriteWatchpoint,
  armGbaPassThrough,
  checkGbaPc,
  checkGbaRead,
  checkGbaWrite,
  clearAllGbaBreakpoints,
  hasGbaPcBreakpoint,
  hasGbaReadWatchpoint,
  hasGbaWriteWatchpoint,
  listGbaPcBreakpoints,
  listGbaReadWatchpoints,
  listGbaWriteWatchpoints,
  peekGbaHit,
  removeGbaPcBreakpoint,
  removeGbaReadWatchpoint,
  removeGbaWriteWatchpoint,
  takeGbaHit,
  toggleGbaPcBreakpoint
} from "./breakpoints.js";

describe("GBA breakpoints registry", () => {
  beforeEach(() => {
    clearAllGbaBreakpoints();
  });

  describe("PC breakpoints", () => {
    it("starts empty", () => {
      expect(listGbaPcBreakpoints()).toEqual([]);
      expect(hasGbaPcBreakpoint(0x08000000)).toBe(false);
    });

    it("add / has / list / remove round-trip", () => {
      addGbaPcBreakpoint(0x08000000);
      addGbaPcBreakpoint(0x030001a4);
      expect(hasGbaPcBreakpoint(0x08000000)).toBe(true);
      expect(hasGbaPcBreakpoint(0x030001a4)).toBe(true);
      // Sort is ascending; 0x03 < 0x08.
      expect(listGbaPcBreakpoints()).toEqual([0x030001a4, 0x08000000]);
      removeGbaPcBreakpoint(0x08000000);
      expect(hasGbaPcBreakpoint(0x08000000)).toBe(false);
      expect(listGbaPcBreakpoints()).toEqual([0x030001a4]);
    });

    it("list is sorted ascending regardless of insertion order", () => {
      addGbaPcBreakpoint(0x0e000000);
      addGbaPcBreakpoint(0x02000010);
      addGbaPcBreakpoint(0x080000c0);
      expect(listGbaPcBreakpoints()).toEqual([0x02000010, 0x080000c0, 0x0e000000]);
    });

    it("normalises addresses to unsigned 32-bit", () => {
      // The registry uses `>>> 0` to coerce negatives / out-of-range
      // values into the canonical uint32 range so callers can pass raw
      // signed numbers from the engine without manual coercion.
      addGbaPcBreakpoint(-1);
      expect(hasGbaPcBreakpoint(0xffffffff)).toBe(true);
    });

    it("toggle flips state and returns the new state", () => {
      expect(toggleGbaPcBreakpoint(0x08000150)).toBe(true);
      expect(hasGbaPcBreakpoint(0x08000150)).toBe(true);
      expect(toggleGbaPcBreakpoint(0x08000150)).toBe(false);
      expect(hasGbaPcBreakpoint(0x08000150)).toBe(false);
    });
  });

  describe("checkGbaPc", () => {
    it("returns false + no hit when set is empty (fast path)", () => {
      expect(checkGbaPc(0x08000000)).toBe(false);
      expect(peekGbaHit()).toBeNull();
    });

    it("returns true and latches a hit on match", () => {
      addGbaPcBreakpoint(0x08000150);
      expect(checkGbaPc(0x08000150)).toBe(true);
      expect(peekGbaHit()).toEqual({ kind: "pc", addr: 0x08000150 });
    });

    it("returns false when PC does not match any breakpoint", () => {
      addGbaPcBreakpoint(0x08000150);
      expect(checkGbaPc(0x08000200)).toBe(false);
      expect(peekGbaHit()).toBeNull();
    });

    it("arms pass-through after takeGbaHit so single-step advances past the BP", () => {
      addGbaPcBreakpoint(0x08000150);
      checkGbaPc(0x08000150);
      takeGbaHit(); // arms 0x08000150
      expect(checkGbaPc(0x08000150)).toBe(false); // pass-through once
      expect(checkGbaPc(0x08000150)).toBe(true); // re-arms, hits on next visit
    });

    it("armGbaPassThrough lets an explicit step cross a BP it is sitting on", () => {
      addGbaPcBreakpoint(0x08000150);
      armGbaPassThrough(0x08000150);
      expect(checkGbaPc(0x08000150)).toBe(false);
    });
  });

  describe("watchpoints", () => {
    it("read and write sets are independent", () => {
      addGbaReadWatchpoint(0x04000130);
      addGbaWriteWatchpoint(0x04000000);
      expect(hasGbaReadWatchpoint(0x04000130)).toBe(true);
      expect(hasGbaWriteWatchpoint(0x04000130)).toBe(false);
      expect(hasGbaReadWatchpoint(0x04000000)).toBe(false);
      expect(hasGbaWriteWatchpoint(0x04000000)).toBe(true);
      expect(listGbaReadWatchpoints()).toEqual([0x04000130]);
      expect(listGbaWriteWatchpoints()).toEqual([0x04000000]);
    });

    it("checkGbaRead latches a hit on a watched address", () => {
      addGbaReadWatchpoint(0x04000130);
      checkGbaRead(0x04000130);
      expect(peekGbaHit()).toEqual({ kind: "read", addr: 0x04000130 });
    });

    it("checkGbaWrite latches a hit on a watched address", () => {
      addGbaWriteWatchpoint(0x04000000);
      checkGbaWrite(0x04000000);
      expect(peekGbaHit()).toEqual({ kind: "write", addr: 0x04000000 });
    });

    it("check* are no-ops on unwatched addresses (fast path)", () => {
      addGbaReadWatchpoint(0x02001234);
      checkGbaRead(0x02005678);
      checkGbaWrite(0x02001234); // only read is watched
      expect(peekGbaHit()).toBeNull();
    });

    it("remove works", () => {
      addGbaReadWatchpoint(0x04000130);
      removeGbaReadWatchpoint(0x04000130);
      expect(hasGbaReadWatchpoint(0x04000130)).toBe(false);
      addGbaWriteWatchpoint(0x04000000);
      removeGbaWriteWatchpoint(0x04000000);
      expect(hasGbaWriteWatchpoint(0x04000000)).toBe(false);
    });
  });

  describe("takeGbaHit", () => {
    it("returns null when nothing is pending", () => {
      expect(takeGbaHit()).toBeNull();
    });

    it("consumes and returns the latched hit", () => {
      addGbaReadWatchpoint(0x04000130);
      checkGbaRead(0x04000130);
      const h = takeGbaHit();
      expect(h).toEqual({ kind: "read", addr: 0x04000130 });
      expect(peekGbaHit()).toBeNull();
      expect(takeGbaHit()).toBeNull();
    });

    it("only arms pass-through for PC hits, not watchpoints", () => {
      addGbaWriteWatchpoint(0x02001234);
      addGbaPcBreakpoint(0x02001234);
      checkGbaWrite(0x02001234); // write-kind hit
      takeGbaHit();
      // 0x02001234 as PC should NOT be armed (the drained hit was a
      // watchpoint, not a PC hit).
      expect(checkGbaPc(0x02001234)).toBe(true);
    });
  });

  describe("clearAllGbaBreakpoints", () => {
    it("wipes every list and clears pending hit", () => {
      addGbaPcBreakpoint(0x08000000);
      addGbaReadWatchpoint(0x04000130);
      addGbaWriteWatchpoint(0x04000000);
      checkGbaPc(0x08000000);
      clearAllGbaBreakpoints();
      expect(listGbaPcBreakpoints()).toEqual([]);
      expect(listGbaReadWatchpoints()).toEqual([]);
      expect(listGbaWriteWatchpoints()).toEqual([]);
      expect(peekGbaHit()).toBeNull();
    });
  });
});
