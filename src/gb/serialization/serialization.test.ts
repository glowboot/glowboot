import { describe, expect, it } from "vitest";

import { StateReader, StateWriter } from "./serialization.js";

describe("StateWriter / StateReader round-trip", () => {
  it("preserves integer and boolean primitives in order", () => {
    const w = new StateWriter();
    w.u8(0xab);
    w.i8(-42);
    w.u16(0xbeef);
    w.i16(-1234);
    w.u32(0xdeadbeef);
    w.i32(-2_000_000);
    w.bool(true);
    w.bool(false);

    const r = new StateReader(w.finalize());
    expect(r.u8()).toBe(0xab);
    expect(r.i8()).toBe(-42);
    expect(r.u16()).toBe(0xbeef);
    expect(r.i16()).toBe(-1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.i32()).toBe(-2_000_000);
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
  });

  it("stores multi-byte integers little-endian on the wire", () => {
    // Explicit byte-level check — subsystems rely on this layout, so
    // changing endianness would silently invalidate every existing save.
    const w = new StateWriter();
    w.u16(0xbeef);
    w.u32(0xdeadbeef);
    const bytes = w.finalize();
    expect(Array.from(bytes)).toEqual([0xef, 0xbe, 0xef, 0xbe, 0xad, 0xde]);
  });

  it("round-trips a float64 (APU sample timer uses one)", () => {
    const w = new StateWriter();
    w.f64(Math.PI);
    w.f64(-0);
    w.f64(1e308);
    const r = new StateReader(w.finalize());
    expect(r.f64()).toBe(Math.PI);
    expect(Object.is(r.f64(), -0)).toBe(true);
    expect(r.f64()).toBe(1e308);
  });

  it("round-trips a byte array without aliasing the source", () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const w = new StateWriter();
    w.bytes(source);
    // Mutate source AFTER writing — the writer should have copied, so
    // the serialised blob shouldn't see the mutation.
    source[0] = 99;

    const dst = new Uint8Array(5);
    new StateReader(w.finalize()).bytes(dst);
    expect(Array.from(dst)).toEqual([1, 2, 3, 4, 5]);
  });

  it("finalize() returns only the bytes actually written, not the full buffer", () => {
    const w = new StateWriter(1024); // over-allocated
    w.u8(0x42);
    w.u8(0x43);
    const bytes = w.finalize();
    expect(bytes.length).toBe(2);
  });
});
