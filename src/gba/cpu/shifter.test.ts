import { describe, expect, it } from "vitest";

import { SHIFT_ASR, SHIFT_LSL, SHIFT_LSR, SHIFT_ROR, shiftByImmediate, shiftByRegister } from "./shifter.js";

describe("shiftByImmediate — LSL", () => {
  it("LSL #0 is a no-op and preserves the input carry", () => {
    expect(shiftByImmediate(0xdeadbeef | 0, SHIFT_LSL, 0, true)).toEqual({
      value: 0xdeadbeef | 0,
      carryOut: true
    });
    expect(shiftByImmediate(0x12345678, SHIFT_LSL, 0, false)).toEqual({
      value: 0x12345678,
      carryOut: false
    });
  });

  it("LSL #1 shifts left by one and exposes bit 31 as carry", () => {
    const res = shiftByImmediate(0x80000001 | 0, SHIFT_LSL, 1, false);
    expect(res.value).toBe(0x00000002);
    expect(res.carryOut).toBe(true);
  });

  it("LSL #31 leaves only bit 0 in the high bit, carry comes from bit 1", () => {
    const res = shiftByImmediate(0x00000003, SHIFT_LSL, 31, false);
    expect(res.value).toBe(0x80000000 | 0);
    expect(res.carryOut).toBe(true);
  });
});

describe("shiftByImmediate — LSR", () => {
  it("LSR #0 means LSR #32 — result is zero, carry comes from bit 31", () => {
    expect(shiftByImmediate(0x80000000 | 0, SHIFT_LSR, 0, false)).toEqual({ value: 0, carryOut: true });
    expect(shiftByImmediate(0x40000000, SHIFT_LSR, 0, true)).toEqual({ value: 0, carryOut: false });
  });

  it("LSR #1 shifts right by one and exposes bit 0 as carry", () => {
    const res = shiftByImmediate(0x00000003, SHIFT_LSR, 1, false);
    expect(res.value).toBe(0x00000001);
    expect(res.carryOut).toBe(true);
  });

  it("LSR #16 unsigned-shifts a high-bit-set operand", () => {
    const res = shiftByImmediate(0x80000000 | 0, SHIFT_LSR, 16, false);
    expect(res.value).toBe(0x00008000);
    expect(res.carryOut).toBe(false);
  });
});

describe("shiftByImmediate — ASR", () => {
  it("ASR #0 means ASR #32 — sign-extends to all-zero or all-ones", () => {
    expect(shiftByImmediate(0x80000000 | 0, SHIFT_ASR, 0, false)).toEqual({ value: -1, carryOut: true });
    expect(shiftByImmediate(0x40000000, SHIFT_ASR, 0, false)).toEqual({ value: 0, carryOut: false });
  });

  it("ASR #1 sign-extends one bit and exposes bit 0 as carry", () => {
    expect(shiftByImmediate(0x80000001 | 0, SHIFT_ASR, 1, false)).toEqual({ value: 0xc0000000 | 0, carryOut: true });
  });
});

describe("shiftByImmediate — ROR / RRX", () => {
  it("ROR #0 means RRX — feeds the input carry into bit 31, exposes bit 0", () => {
    expect(shiftByImmediate(0x00000001, SHIFT_ROR, 0, true)).toEqual({ value: 0x80000000 | 0, carryOut: true });
    expect(shiftByImmediate(0x80000002 | 0, SHIFT_ROR, 0, false)).toEqual({ value: 0x40000001, carryOut: false });
  });

  it("ROR #1 rotates by one and exposes bit 0 as carry", () => {
    expect(shiftByImmediate(0x00000001, SHIFT_ROR, 1, false)).toEqual({ value: 0x80000000 | 0, carryOut: true });
  });

  it("ROR #16 swaps the halves; carry comes from bit 15 of the operand", () => {
    expect(shiftByImmediate(0xaabbccdd | 0, SHIFT_ROR, 16, false)).toEqual({ value: 0xccddaabb | 0, carryOut: true });
    expect(shiftByImmediate(0x00010000, SHIFT_ROR, 16, false)).toEqual({ value: 0x00000001, carryOut: false });
  });
});

describe("shiftByRegister — Rs = 0", () => {
  it("returns operand unchanged with carry preserved for every shift type", () => {
    for (const t of [SHIFT_LSL, SHIFT_LSR, SHIFT_ASR, SHIFT_ROR] as const) {
      expect(shiftByRegister(0xcafebabe | 0, t, 0, true)).toEqual({ value: 0xcafebabe | 0, carryOut: true });
      expect(shiftByRegister(0xcafebabe | 0, t, 0, false)).toEqual({ value: 0xcafebabe | 0, carryOut: false });
    }
  });
});

describe("shiftByRegister — LSL with large amounts", () => {
  it("LSL Rs=31 puts bit 0 in bit 31", () => {
    expect(shiftByRegister(0x00000003, SHIFT_LSL, 31, false)).toEqual({ value: 0x80000000 | 0, carryOut: true });
  });
  it("LSL Rs=32 → result 0, carry = bit 0 of operand", () => {
    expect(shiftByRegister(0x00000001, SHIFT_LSL, 32, false)).toEqual({ value: 0, carryOut: true });
    expect(shiftByRegister(0x00000002, SHIFT_LSL, 32, false)).toEqual({ value: 0, carryOut: false });
  });
  it("LSL Rs>32 → result 0, carry 0", () => {
    expect(shiftByRegister(0xffffffff | 0, SHIFT_LSL, 64, true)).toEqual({ value: 0, carryOut: false });
  });
});

describe("shiftByRegister — LSR with large amounts", () => {
  it("LSR Rs=32 → result 0, carry = bit 31", () => {
    expect(shiftByRegister(0x80000000 | 0, SHIFT_LSR, 32, false)).toEqual({ value: 0, carryOut: true });
    expect(shiftByRegister(0x40000000, SHIFT_LSR, 32, false)).toEqual({ value: 0, carryOut: false });
  });
  it("LSR Rs>32 → result 0, carry 0", () => {
    expect(shiftByRegister(0xffffffff | 0, SHIFT_LSR, 64, true)).toEqual({ value: 0, carryOut: false });
  });
});

describe("shiftByRegister — ASR with large amounts", () => {
  it("ASR Rs≥32 sign-extends the operand", () => {
    expect(shiftByRegister(0x80000000 | 0, SHIFT_ASR, 32, false)).toEqual({ value: -1, carryOut: true });
    expect(shiftByRegister(0x80000000 | 0, SHIFT_ASR, 100, false)).toEqual({ value: -1, carryOut: true });
    expect(shiftByRegister(0x40000000, SHIFT_ASR, 100, false)).toEqual({ value: 0, carryOut: false });
  });
});

describe("shiftByRegister — ROR with rotate-of-32 quirk", () => {
  it("ROR with low-5-bits-zero (and Rs ≠ 0) leaves operand unchanged, carry = bit 31", () => {
    expect(shiftByRegister(0x80000000 | 0, SHIFT_ROR, 32, false)).toEqual({ value: 0x80000000 | 0, carryOut: true });
    expect(shiftByRegister(0x40000000, SHIFT_ROR, 64, false)).toEqual({ value: 0x40000000, carryOut: false });
  });
  it("ROR Rs=33 is equivalent to ROR #1", () => {
    expect(shiftByRegister(0x00000001, SHIFT_ROR, 33, false)).toEqual({ value: 0x80000000 | 0, carryOut: true });
  });
});
