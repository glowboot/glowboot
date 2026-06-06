import { describe, expect, it } from "vitest";

import { BaseIoHandler } from "./io-handler-base.js";

/** Minimal subclass: stores halfwords in a four-slot array indexed by
 *  `offset >>> 1`. Just enough state for the abstract base's width
 *  adapters to thread reads + writes through and for the test to
 *  observe both the result of each read and the residual store state
 *  after each write. */
class FakeHalfwordHandler extends BaseIoHandler {
  /** 4 slots × 2 bytes = covers offsets 0x0..0x7. */
  slots = [0, 0, 0, 0];
  /** Per-call log of read16 / write16 invocations so tests can verify
   *  the base's call sequence (e.g. read32 must call read16 twice,
   *  low-then-high). */
  calls: { kind: "r" | "w"; offset: number; value?: number }[] = [];

  read16(offset: number): number {
    this.calls.push({ kind: "r", offset });
    return this.slots[(offset & 0xf) >>> 1] ?? 0;
  }
  write16(offset: number, value: number): void {
    this.calls.push({ kind: "w", offset, value: value & 0xffff });
    this.slots[(offset & 0xf) >>> 1] = value & 0xffff;
  }
}

describe("BaseIoHandler.read8", () => {
  it("returns the low byte at an even offset", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0xabcd;
    expect(h.read8(0x0)).toBe(0xcd);
  });

  it("returns the high byte at an odd offset", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0xabcd;
    expect(h.read8(0x1)).toBe(0xab);
  });

  it("realigns the offset before calling read16 — odd-byte reads still go through the aligned halfword", () => {
    const h = new FakeHalfwordHandler();
    h.slots[1] = 0x1234;
    h.read8(0x3);
    expect(h.calls).toEqual([{ kind: "r", offset: 0x2 }]);
  });
});

describe("BaseIoHandler.write8", () => {
  it("load-modify-stores the low byte at an even offset, preserving the high byte", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0xffff;
    h.write8(0x0, 0xab);
    expect(h.slots[0]).toBe(0xffab);
  });

  it("load-modify-stores the high byte at an odd offset, preserving the low byte", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0xffff;
    h.write8(0x1, 0xcd);
    expect(h.slots[0]).toBe(0xcdff);
  });

  it("issues exactly one read16 and one write16, both at the aligned offset", () => {
    const h = new FakeHalfwordHandler();
    h.slots[2] = 0xabcd;
    h.write8(0x5, 0x12);
    expect(h.calls).toEqual([
      { kind: "r", offset: 0x4 },
      { kind: "w", offset: 0x4, value: 0x12cd }
    ]);
  });

  it("masks the source value to a byte before merging", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0x0000;
    h.write8(0x0, 0xffff_abcd | 0);
    expect(h.slots[0]).toBe(0x00cd);
  });
});

describe("BaseIoHandler.read32", () => {
  it("joins two consecutive halfwords low-then-high", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0xaaaa;
    h.slots[1] = 0xbbbb;
    expect(h.read32(0x0) >>> 0).toBe(0xbbbbaaaa);
  });

  it("realigns the offset to a 4-byte boundary before reading", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0x1234;
    h.slots[1] = 0x5678;
    h.read32(0x3); // bits 0-1 ignored, aligns to 0x0
    expect(h.calls).toEqual([
      { kind: "r", offset: 0x0 },
      { kind: "r", offset: 0x2 }
    ]);
  });

  it("returns a 32-bit value with the high halfword unsigned-shifted", () => {
    const h = new FakeHalfwordHandler();
    h.slots[0] = 0x0000;
    h.slots[1] = 0x8000;
    // 0x8000 << 16 would be -0x80000000 if signed; the base's `| 0`
    // makes the contract clear — callers should treat it as a u32 via
    // `>>> 0`, but the produced bit pattern is correct either way.
    expect(h.read32(0) >>> 0).toBe(0x80000000);
  });
});

describe("BaseIoHandler.write32", () => {
  it("splits a 32-bit value into two halfword writes, low-then-high", () => {
    const h = new FakeHalfwordHandler();
    h.write32(0x0, 0xdeadbeef | 0);
    expect(h.slots[0]).toBe(0xbeef);
    expect(h.slots[1]).toBe(0xdead);
  });

  it("realigns the offset to a 4-byte boundary before writing", () => {
    const h = new FakeHalfwordHandler();
    h.write32(0x3, 0x11112222);
    expect(h.calls).toEqual([
      { kind: "w", offset: 0x0, value: 0x2222 },
      { kind: "w", offset: 0x2, value: 0x1111 }
    ]);
  });

  it("masks each halfword on the way out so the subclass sees clean 16-bit values", () => {
    const h = new FakeHalfwordHandler();
    h.write32(0x0, 0xffffffff | 0);
    // Both writes should have arrived as 0xffff exactly — no sign
    // extension or upper-bit leakage.
    expect(h.calls).toEqual([
      { kind: "w", offset: 0x0, value: 0xffff },
      { kind: "w", offset: 0x2, value: 0xffff }
    ]);
  });
});

describe("BaseIoHandler — abstract contract", () => {
  it("subclasses can override individual width adapters (Joypad pattern)", () => {
    // Verifies that the public methods are virtual: overriding write8
    // in a subclass takes precedence over the base's load-modify-store,
    // which is how Joypad enforces KEYINPUT read-only-ness.
    const calls: string[] = [];
    class OverridingHandler extends BaseIoHandler {
      read16(_offset: number): number {
        return 0;
      }
      write16(_offset: number, _value: number): void {
        calls.push("w16");
      }
      override write8(_offset: number, _value: number): void {
        calls.push("custom-w8");
      }
    }
    const h = new OverridingHandler();
    h.write8(0x0, 0xff);
    expect(calls).toEqual(["custom-w8"]);
  });
});
