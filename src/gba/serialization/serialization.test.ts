import { describe, expect, it } from "vitest";

import {
  GBA_STATE_VERSION,
  GbaStateReader,
  GbaStateWriter,
  UnsupportedGbaSaveStateError,
  upgradeGbaState
} from "./serialization.js";

describe("GbaStateWriter / GbaStateReader round-trip", () => {
  it("preserves integer and boolean primitives in order", () => {
    const w = new GbaStateWriter();
    w.u8(0xab);
    w.i8(-42);
    w.u16(0xbeef);
    w.i16(-1234);
    w.u32(0xdeadbeef);
    w.i32(-2_000_000);
    w.bool(true);
    w.bool(false);

    const r = new GbaStateReader(w.finalize());
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
    const w = new GbaStateWriter();
    w.u16(0xbeef);
    w.u32(0xdeadbeef);
    const bytes = w.finalize();
    expect(Array.from(bytes)).toEqual([0xef, 0xbe, 0xef, 0xbe, 0xad, 0xde]);
  });

  it("round-trips a float64", () => {
    const w = new GbaStateWriter();
    w.f64(Math.PI);
    w.f64(-0);
    w.f64(1e308);
    const r = new GbaStateReader(w.finalize());
    expect(r.f64()).toBe(Math.PI);
    expect(Object.is(r.f64(), -0)).toBe(true);
    expect(r.f64()).toBe(1e308);
  });

  it("round-trips a byte array without aliasing the source", () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const w = new GbaStateWriter();
    w.bytes(source);
    // Mutate source AFTER writing — the writer should have copied, so
    // the serialised blob shouldn't see the mutation.
    source[0] = 99;

    const dst = new Uint8Array(5);
    new GbaStateReader(w.finalize()).bytes(dst);
    expect(Array.from(dst)).toEqual([1, 2, 3, 4, 5]);
  });

  it("finalize() returns only the bytes actually written, not the full buffer", () => {
    const w = new GbaStateWriter(1024); // over-allocated
    w.u8(0x42);
    w.u8(0x43);
    const bytes = w.finalize();
    expect(bytes.length).toBe(2);
  });
});

describe("upgradeGbaState", () => {
  it("returns blobs at the current version unchanged", () => {
    const blob = new Uint8Array([GBA_STATE_VERSION, 0xaa, 0xbb]);
    const out = upgradeGbaState(blob);
    expect(out).toBe(blob); // no copy when no migration is needed
  });

  it("rejects an empty blob with UnsupportedGbaSaveStateError", () => {
    expect(() => upgradeGbaState(new Uint8Array())).toThrow(UnsupportedGbaSaveStateError);
  });

  it("rejects a future-version blob (newer than this build)", () => {
    const blob = new Uint8Array([GBA_STATE_VERSION + 1, 0xff]);
    expect(() => upgradeGbaState(blob)).toThrow(UnsupportedGbaSaveStateError);
  });

  it("rejects an older-than-oldest blob (no migrator registered)", () => {
    // v0 with no migrator registered for v0→v1 — this is the
    // realistic "very old save from before the lineage existed" case.
    expect(() => upgradeGbaState(new Uint8Array([0]))).toThrow(UnsupportedGbaSaveStateError);
  });
});
