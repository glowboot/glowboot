import { beforeEach, describe, expect, it } from "vitest";

import { StateReader, StateWriter } from "../serialization/serialization.js";
import {
  INTERRUPT_JOYPAD,
  INTERRUPT_LCD,
  INTERRUPT_SERIAL,
  INTERRUPT_TIMER,
  INTERRUPT_VBLANK,
  INTERRUPT_VECTORS,
  InterruptController
} from "./interrupts.js";

describe("InterruptController", () => {
  let ic: InterruptController;

  beforeEach(() => {
    ic = new InterruptController();
  });

  describe("request", () => {
    it("OR-s the flag bit into IF without clobbering other bits", () => {
      ic.if = INTERRUPT_VBLANK;
      ic.request(INTERRUPT_TIMER);
      expect(ic.if).toBe(INTERRUPT_VBLANK | INTERRUPT_TIMER);
    });

    it("is idempotent — requesting a pending interrupt is a no-op", () => {
      ic.request(INTERRUPT_VBLANK);
      ic.request(INTERRUPT_VBLANK);
      expect(ic.if).toBe(INTERRUPT_VBLANK);
    });
  });

  describe("pending", () => {
    it("returns 0 when nothing is enabled", () => {
      ic.if = 0xff;
      ic.ie = 0;
      expect(ic.pending()).toBe(0);
    });

    it("returns 0 when nothing is flagged", () => {
      ic.ie = 0xff;
      ic.if = 0;
      expect(ic.pending()).toBe(0);
    });

    it("returns the bit corresponding to the highest-priority pending source", () => {
      // Priority order: VBlank (bit 0) highest, Joypad (bit 4) lowest.
      ic.ie = 0x1f;
      ic.if = INTERRUPT_JOYPAD | INTERRUPT_LCD;
      expect(ic.pending()).toBe(INTERRUPT_LCD);
    });

    it("masks off bits above 4 — only five hardware interrupts exist", () => {
      ic.ie = 0xff;
      ic.if = 0xe0; // only bits 5-7, which aren't real interrupts
      expect(ic.pending()).toBe(0);
    });
  });

  describe("acknowledge", () => {
    it("clears the specific bit, leaves others alone", () => {
      ic.if = INTERRUPT_VBLANK | INTERRUPT_TIMER | INTERRUPT_JOYPAD;
      ic.acknowledge(INTERRUPT_TIMER);
      expect(ic.if).toBe(INTERRUPT_VBLANK | INTERRUPT_JOYPAD);
    });
  });

  describe("INTERRUPT_VECTORS", () => {
    it.each([
      [INTERRUPT_VBLANK, 0x0040],
      [INTERRUPT_LCD, 0x0048],
      [INTERRUPT_TIMER, 0x0050],
      [INTERRUPT_SERIAL, 0x0058],
      [INTERRUPT_JOYPAD, 0x0060]
    ])("interrupt 0x%x dispatches to vector 0x%x", (flag, addr) => {
      expect(INTERRUPT_VECTORS[flag]).toBe(addr);
    });
  });

  describe("serialization", () => {
    it("round-trips IE and IF", () => {
      ic.ie = 0x1f;
      ic.if = INTERRUPT_TIMER | INTERRUPT_VBLANK;
      const w = new StateWriter();
      ic.serialize(w);

      const dst = new InterruptController();
      dst.deserialize(new StateReader(w.finalize()));
      expect(dst.ie).toBe(0x1f);
      expect(dst.if).toBe(INTERRUPT_TIMER | INTERRUPT_VBLANK);
    });
  });
});
