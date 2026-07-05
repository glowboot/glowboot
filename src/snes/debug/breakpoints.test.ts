import { beforeEach, describe, expect, it } from "vitest";

import {
  addSnesPcBreakpoint,
  armSnesPassThrough,
  checkSnesPc,
  clearAllSnesBreakpoints,
  hasSnesPcBreakpoint,
  listSnesPcBreakpoints,
  peekSnesHit,
  removeSnesPcBreakpoint,
  takeSnesHit,
  toggleSnesPcBreakpoint
} from "./breakpoints.js";

describe("SNES breakpoints registry", () => {
  beforeEach(() => {
    clearAllSnesBreakpoints();
  });

  describe("PC breakpoints", () => {
    it("starts empty", () => {
      expect(listSnesPcBreakpoints()).toEqual([]);
      expect(hasSnesPcBreakpoint(0x808000)).toBe(false);
    });

    it("add / has / list / remove round-trip", () => {
      addSnesPcBreakpoint(0x808000);
      addSnesPcBreakpoint(0x7e1a04);
      expect(hasSnesPcBreakpoint(0x808000)).toBe(true);
      expect(hasSnesPcBreakpoint(0x7e1a04)).toBe(true);
      // Sort is ascending; bank $7E < bank $80.
      expect(listSnesPcBreakpoints()).toEqual([0x7e1a04, 0x808000]);
      removeSnesPcBreakpoint(0x808000);
      expect(hasSnesPcBreakpoint(0x808000)).toBe(false);
      expect(listSnesPcBreakpoints()).toEqual([0x7e1a04]);
    });

    it("list is sorted ascending regardless of insertion order", () => {
      addSnesPcBreakpoint(0xc00000);
      addSnesPcBreakpoint(0x008010);
      addSnesPcBreakpoint(0x8080c0);
      expect(listSnesPcBreakpoints()).toEqual([0x008010, 0x8080c0, 0xc00000]);
    });

    it("normalises addresses to 24 bits", () => {
      // The registry masks with `& 0xffffff` so callers can pass a raw
      // `(pbr << 16) | pc` without manual coercion of oversized banks.
      addSnesPcBreakpoint(0x1808000);
      expect(hasSnesPcBreakpoint(0x808000)).toBe(true);
    });

    it("toggle flips state and returns the new state", () => {
      expect(toggleSnesPcBreakpoint(0x808150)).toBe(true);
      expect(hasSnesPcBreakpoint(0x808150)).toBe(true);
      expect(toggleSnesPcBreakpoint(0x808150)).toBe(false);
      expect(hasSnesPcBreakpoint(0x808150)).toBe(false);
    });
  });

  describe("checkSnesPc", () => {
    it("returns false + no hit when set is empty (fast path)", () => {
      expect(checkSnesPc(0x808000)).toBe(false);
      expect(peekSnesHit()).toBeNull();
    });

    it("returns true and latches a hit on match", () => {
      addSnesPcBreakpoint(0x808150);
      expect(checkSnesPc(0x808150)).toBe(true);
      expect(peekSnesHit()).toEqual({ kind: "pc", addr: 0x808150 });
    });

    it("returns false when PC does not match any breakpoint", () => {
      addSnesPcBreakpoint(0x808150);
      expect(checkSnesPc(0x808200)).toBe(false);
      expect(peekSnesHit()).toBeNull();
    });

    it("arms pass-through after takeSnesHit so single-step advances past the BP", () => {
      addSnesPcBreakpoint(0x808150);
      checkSnesPc(0x808150);
      takeSnesHit(); // arms 0x808150
      expect(checkSnesPc(0x808150)).toBe(false); // pass-through once
      expect(checkSnesPc(0x808150)).toBe(true); // re-arms, hits on next visit
    });

    it("armSnesPassThrough lets an explicit step cross a BP it is sitting on", () => {
      addSnesPcBreakpoint(0x808150);
      armSnesPassThrough(0x808150);
      expect(checkSnesPc(0x808150)).toBe(false);
    });
  });

  describe("takeSnesHit", () => {
    it("returns null when nothing is pending", () => {
      expect(takeSnesHit()).toBeNull();
    });

    it("consumes and returns the latched hit", () => {
      addSnesPcBreakpoint(0x008000);
      checkSnesPc(0x008000);
      const h = takeSnesHit();
      expect(h).toEqual({ kind: "pc", addr: 0x008000 });
      expect(peekSnesHit()).toBeNull();
      expect(takeSnesHit()).toBeNull();
    });
  });

  describe("clearAllSnesBreakpoints", () => {
    it("wipes the list, the pending hit, and the armed pass-through", () => {
      addSnesPcBreakpoint(0x808000);
      checkSnesPc(0x808000);
      takeSnesHit(); // arms 0x808000
      clearAllSnesBreakpoints();
      expect(listSnesPcBreakpoints()).toEqual([]);
      expect(peekSnesHit()).toBeNull();
      // Re-add: the cleared armed PC must not let the next visit through.
      addSnesPcBreakpoint(0x808000);
      expect(checkSnesPc(0x808000)).toBe(true);
    });
  });
});
