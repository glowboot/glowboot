import { beforeEach, describe, expect, it } from "vitest";

import { INTERRUPT_TIMER, InterruptController } from "../memory/interrupts.js";
import { StateReader, StateWriter } from "../serialization/serialization.js";
import { Timer } from "./timer.js";

describe("Timer", () => {
  let interrupts: InterruptController;
  let timer: Timer;

  beforeEach(() => {
    interrupts = new InterruptController();
    timer = new Timer(interrupts);
    // Reset DIV so tests start from a clean slate — constructor seeds
    // the post-boot value (0xABCC) which is awkward for arithmetic.
    timer.writeByte(0xff04, 0);
  });

  describe("DIV (0xFF04)", () => {
    it("reads as the upper byte of the internal 16-bit DIV counter", () => {
      timer.tick(64); // 64 M-cycles = 256 T-cycles → DIV increments by 1
      expect(timer.readByte(0xff04)).toBe(0x01);
    });

    it("resets to 0 on any write, regardless of value", () => {
      timer.tick(64 * 100); // raise DIV to 100
      timer.writeByte(0xff04, 0x42);
      expect(timer.readByte(0xff04)).toBe(0);
    });

    it("wraps at the 16-bit boundary", () => {
      // 0x10000 T-cycles / 4 = 0x4000 M-cycles brings DIV back to 0.
      timer.tick(0x4000);
      expect(timer.readByte(0xff04)).toBe(0);
    });
  });

  describe("TIMA (0xFF05) driven by TAC", () => {
    it("does not tick while the timer-enable bit is clear (TAC bit 2 = 0)", () => {
      timer.writeByte(0xff07, 0x00); // disabled, mode 0
      timer.tick(10_000);
      expect(timer.readByte(0xff05)).toBe(0);
    });

    it.each([
      ["4096 Hz (TAC=0b100)", 0b100, 256, 1], // every 256 M-cycles
      ["262144 Hz (TAC=0b101)", 0b101, 4, 1], // every 4 M-cycles
      ["65536 Hz (TAC=0b110)", 0b110, 16, 1], // every 16 M-cycles
      ["16384 Hz (TAC=0b111)", 0b111, 64, 1] // every 64 M-cycles
    ])("clocks at %s", (_name, tac, mCyclesPerTick, expectedTicks) => {
      timer.writeByte(0xff07, tac);
      timer.tick(mCyclesPerTick);
      expect(timer.readByte(0xff05)).toBe(expectedTicks);
    });

    it("reloads TMA and fires INTERRUPT_TIMER on overflow", () => {
      timer.writeByte(0xff06, 0x42); // TMA
      timer.writeByte(0xff05, 0xff); // TIMA one step away from wrap
      timer.writeByte(0xff07, 0b101); // enabled, fastest (every 4 M-cycles)
      // Real hardware leaves TIMA = 0 for one M-cycle after overflow before
      // the TMA reload + IRQ; tick(4) hits the overflow, tick(5) commits.
      timer.tick(4);
      expect(timer.readByte(0xff05)).toBe(0x00);
      timer.tick(2);
      expect(timer.readByte(0xff05)).toBe(0x42);
      expect(interrupts.if & INTERRUPT_TIMER).toBe(INTERRUPT_TIMER);
    });

    it("handles multiple ticks in one bulk call (the common hot path)", () => {
      timer.writeByte(0xff07, 0b101); // fastest
      timer.tick(16); // 4 ticks worth
      expect(timer.readByte(0xff05)).toBe(4);
    });
  });

  describe("TMA (0xFF06) and TAC (0xFF07)", () => {
    it("read back what was written", () => {
      timer.writeByte(0xff06, 0xcd);
      timer.writeByte(0xff07, 0x07);
      expect(timer.readByte(0xff06)).toBe(0xcd);
      // TAC bits 3-7 are unused and read as 1 on real hardware (Mooneye
      // `unused_hwio-{GS,C}`); only bits 0-2 carry meaning.
      expect(timer.readByte(0xff07)).toBe(0xff);
    });

    it("masks TAC writes to bits 0-2 — bits 3-7 are unused and read as 1", () => {
      timer.writeByte(0xff07, 0x00);
      expect(timer.readByte(0xff07)).toBe(0xf8);
    });
  });

  describe("read from unrelated address", () => {
    it("returns 0xFF for any address the timer doesn't own", () => {
      expect(timer.readByte(0xff10)).toBe(0xff);
    });
  });

  describe("serialization", () => {
    it("round-trips DIV, TIMA, TMA, TAC", () => {
      timer.tick(64 * 7); // DIV = 7
      timer.writeByte(0xff05, 0x42);
      timer.writeByte(0xff06, 0xab);
      timer.writeByte(0xff07, 0x05);

      const w = new StateWriter();
      timer.serialize(w);
      const dst = new Timer(new InterruptController());
      dst.deserialize(new StateReader(w.finalize()));

      expect(dst.readByte(0xff04)).toBe(7);
      expect(dst.readByte(0xff05)).toBe(0x42);
      expect(dst.readByte(0xff06)).toBe(0xab);
      expect(dst.readByte(0xff07)).toBe(0xfd); // 0x05 with unused bits 3-7 forced to 1
    });
  });
});
