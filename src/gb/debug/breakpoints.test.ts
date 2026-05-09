import { beforeEach, describe, expect, it } from "vitest";

import {
  addPcBreakpoint,
  addReadWatchpoint,
  addWriteWatchpoint,
  armPassThrough,
  checkPc,
  checkRead,
  checkWrite,
  clearAll,
  hasPcBreakpoint,
  hasReadWatchpoint,
  hasWriteWatchpoint,
  listPcBreakpoints,
  listReadWatchpoints,
  listWriteWatchpoints,
  peekHit,
  removePcBreakpoint,
  removeReadWatchpoint,
  removeWriteWatchpoint,
  takeHit,
  togglePcBreakpoint
} from "./breakpoints.js";

describe("breakpoints registry", () => {
  beforeEach(() => {
    clearAll();
  });

  describe("PC breakpoints", () => {
    it("starts empty", () => {
      expect(listPcBreakpoints()).toEqual([]);
      expect(hasPcBreakpoint(0x0100)).toBe(false);
    });

    it("add / has / list / remove round-trip", () => {
      addPcBreakpoint(0x0100);
      addPcBreakpoint(0x4a8c);
      expect(hasPcBreakpoint(0x0100)).toBe(true);
      expect(hasPcBreakpoint(0x4a8c)).toBe(true);
      expect(listPcBreakpoints()).toEqual([0x0100, 0x4a8c]);
      removePcBreakpoint(0x0100);
      expect(hasPcBreakpoint(0x0100)).toBe(false);
      expect(listPcBreakpoints()).toEqual([0x4a8c]);
    });

    it("list is sorted ascending regardless of insertion order", () => {
      addPcBreakpoint(0xff80);
      addPcBreakpoint(0x0100);
      addPcBreakpoint(0x4000);
      expect(listPcBreakpoints()).toEqual([0x0100, 0x4000, 0xff80]);
    });

    it("masks addresses to 16 bits", () => {
      addPcBreakpoint(0x10100);
      expect(hasPcBreakpoint(0x0100)).toBe(true);
    });

    it("toggle flips state and returns the new state", () => {
      expect(togglePcBreakpoint(0x0150)).toBe(true);
      expect(hasPcBreakpoint(0x0150)).toBe(true);
      expect(togglePcBreakpoint(0x0150)).toBe(false);
      expect(hasPcBreakpoint(0x0150)).toBe(false);
    });
  });

  describe("checkPc", () => {
    it("returns false + no hit when set is empty (fast path)", () => {
      expect(checkPc(0x0100)).toBe(false);
      expect(peekHit()).toBeNull();
    });

    it("returns true and latches a hit on match", () => {
      addPcBreakpoint(0x0150);
      expect(checkPc(0x0150)).toBe(true);
      expect(peekHit()).toEqual({ kind: "pc", addr: 0x0150 });
    });

    it("returns false when PC does not match any breakpoint", () => {
      addPcBreakpoint(0x0150);
      expect(checkPc(0x0200)).toBe(false);
      expect(peekHit()).toBeNull();
    });

    it("arms pass-through after takeHit so single-step advances past the BP", () => {
      addPcBreakpoint(0x0150);
      checkPc(0x0150);
      takeHit(); // arms 0x0150
      expect(checkPc(0x0150)).toBe(false); // pass-through once
      expect(checkPc(0x0150)).toBe(true); // re-arms, hits on next visit
    });

    it("armPassThrough lets an explicit step cross a BP it is sitting on", () => {
      addPcBreakpoint(0x0150);
      armPassThrough(0x0150);
      expect(checkPc(0x0150)).toBe(false);
    });
  });

  describe("watchpoints", () => {
    it("read and write sets are independent", () => {
      addReadWatchpoint(0xff44);
      addWriteWatchpoint(0xff40);
      expect(hasReadWatchpoint(0xff44)).toBe(true);
      expect(hasWriteWatchpoint(0xff44)).toBe(false);
      expect(hasReadWatchpoint(0xff40)).toBe(false);
      expect(hasWriteWatchpoint(0xff40)).toBe(true);
      expect(listReadWatchpoints()).toEqual([0xff44]);
      expect(listWriteWatchpoints()).toEqual([0xff40]);
    });

    it("checkRead latches a hit on a watched address", () => {
      addReadWatchpoint(0xff44);
      checkRead(0xff44);
      expect(peekHit()).toEqual({ kind: "read", addr: 0xff44 });
    });

    it("checkWrite latches a hit on a watched address", () => {
      addWriteWatchpoint(0xff40);
      checkWrite(0xff40);
      expect(peekHit()).toEqual({ kind: "write", addr: 0xff40 });
    });

    it("checkRead / checkWrite are no-ops on unwatched addresses (fast path)", () => {
      addReadWatchpoint(0x1234);
      checkRead(0x5678);
      checkWrite(0x1234); // only read is watched
      expect(peekHit()).toBeNull();
    });

    it("remove works", () => {
      addReadWatchpoint(0xff44);
      removeReadWatchpoint(0xff44);
      expect(hasReadWatchpoint(0xff44)).toBe(false);
      addWriteWatchpoint(0xff40);
      removeWriteWatchpoint(0xff40);
      expect(hasWriteWatchpoint(0xff40)).toBe(false);
    });
  });

  describe("takeHit", () => {
    it("returns null when nothing is pending", () => {
      expect(takeHit()).toBeNull();
    });

    it("consumes and returns the latched hit", () => {
      addReadWatchpoint(0xff44);
      checkRead(0xff44);
      const h = takeHit();
      expect(h).toEqual({ kind: "read", addr: 0xff44 });
      expect(peekHit()).toBeNull();
      expect(takeHit()).toBeNull();
    });

    it("only arms pass-through for PC hits, not watchpoints", () => {
      addWriteWatchpoint(0x1234);
      addPcBreakpoint(0x1234);
      checkWrite(0x1234); // write-kind hit
      takeHit();
      // 0x1234 PC should NOT be armed (last drained hit was a watchpoint).
      expect(checkPc(0x1234)).toBe(true);
    });
  });

  describe("clearAll", () => {
    it("wipes every list and clears pending hit", () => {
      addPcBreakpoint(0x0100);
      addReadWatchpoint(0xff44);
      addWriteWatchpoint(0xff40);
      checkPc(0x0100);
      clearAll();
      expect(listPcBreakpoints()).toEqual([]);
      expect(listReadWatchpoints()).toEqual([]);
      expect(listWriteWatchpoints()).toEqual([]);
      expect(peekHit()).toBeNull();
    });
  });
});
