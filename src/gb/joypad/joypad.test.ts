import { beforeEach, describe, expect, it } from "vitest";

import { INTERRUPT_JOYPAD, InterruptController } from "../memory/interrupts.js";
import { Joypad } from "./joypad.js";

describe("Joypad", () => {
  let interrupts: InterruptController;
  let joypad: Joypad;

  beforeEach(() => {
    interrupts = new InterruptController();
    joypad = new Joypad(interrupts);
  });

  describe("read()", () => {
    it("returns 0xFF when nothing is pressed and no column is selected", () => {
      // Default select value (0xFF) has both selector bits high, which means
      // NEITHER the action nor direction column is being polled — all four
      // low bits read as 1 (released) regardless of internal state. Top
      // two bits always read 1 (unwired on real hardware).
      expect(joypad.read()).toBe(0xff);
    });

    it("reports action buttons when bit 5 is cleared", () => {
      joypad.write(0x10); // bit 5 = 0 (select action), bit 4 = 1
      joypad.press("a");
      joypad.press("start");
      // lo = 0x0F & ~0x01 (A) & ~0x08 (Start) = 0x06
      // top bits: (select & 0x30) | 0xC0 = 0x10 | 0xC0 = 0xD0
      expect(joypad.read()).toBe(0xd6);
    });

    it("reports direction buttons when bit 4 is cleared", () => {
      joypad.write(0x20); // bit 4 = 0 (select direction)
      joypad.press("right");
      joypad.press("up");
      // lo = 0x0F & ~0x01 (Right) & ~0x04 (Up) = 0x0A
      expect(joypad.read()).toBe(0xea);
    });

    it("ignores direction buttons while action column is selected", () => {
      joypad.write(0x10); // action column only
      joypad.press("up");
      joypad.press("down");
      // No action buttons pressed — all four low bits read as 1.
      expect(joypad.read() & 0x0f).toBe(0x0f);
    });

    it("combines both columns when both selector bits are low", () => {
      joypad.write(0x00); // both columns active
      joypad.press("a"); // action bit 0
      joypad.press("down"); // direction bit 3
      // lo merges: A clears bit 0, Down clears bit 3 → 0x06
      expect(joypad.read() & 0x0f).toBe(0x06);
    });
  });

  describe("press() interrupt behaviour", () => {
    it("requests a joypad interrupt on every fresh press", () => {
      joypad.press("a");
      expect(interrupts.if & INTERRUPT_JOYPAD).toBe(INTERRUPT_JOYPAD);
    });

    it("does not request again while the button is already held", () => {
      joypad.press("a");
      interrupts.if = 0; // clear the fired interrupt
      joypad.press("a"); // repeated press without release
      expect(interrupts.if & INTERRUPT_JOYPAD).toBe(0);
    });

    it("re-arms the interrupt after release + press", () => {
      joypad.press("a");
      joypad.release("a");
      interrupts.if = 0;
      joypad.press("a");
      expect(interrupts.if & INTERRUPT_JOYPAD).toBe(INTERRUPT_JOYPAD);
    });
  });

  describe("write()", () => {
    it("only latches the two selector bits (4-5); bits 0-3 are read-only", () => {
      joypad.write(0xff); // try to set everything
      // Subsequent read with no presses should show 0xFF as well; but the
      // internal `select` should only carry 0x30, not 0xFF. Easiest way to
      // observe it: write a fresh bit-4-clear, then confirm direction read
      // works (bits 0-3 of the write were never latched).
      joypad.write(0x20);
      joypad.press("left");
      expect(joypad.read() & 0x0f).toBe(0x0d); // bit 1 cleared by Left
    });
  });
});
