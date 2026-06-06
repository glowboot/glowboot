import { describe, expect, it } from "vitest";

import { FlatBus } from "./bus.js";

describe("FlatBus reads and writes", () => {
  it("round-trips a 32-bit value in little-endian order", () => {
    const bus = new FlatBus(0x100);
    bus.write32(0x10, 0xdeadbeef | 0);
    expect(bus.read32(0x10) >>> 0).toBe(0xdeadbeef);
    expect(bus.read8(0x10)).toBe(0xef);
    expect(bus.read8(0x11)).toBe(0xbe);
    expect(bus.read8(0x12)).toBe(0xad);
    expect(bus.read8(0x13)).toBe(0xde);
  });

  it("round-trips a 16-bit value in little-endian order", () => {
    const bus = new FlatBus(0x100);
    bus.write16(0x20, 0xbeef);
    expect(bus.read16(0x20)).toBe(0xbeef);
    expect(bus.read8(0x20)).toBe(0xef);
    expect(bus.read8(0x21)).toBe(0xbe);
  });

  it("reads past end-of-array return zero rather than undefined", () => {
    const bus = new FlatBus(0x10);
    expect(bus.read32(0x100)).toBe(0);
    expect(bus.read16(0x100)).toBe(0);
    expect(bus.read8(0x100)).toBe(0);
  });

  it("masks 32-bit writes to byte width per lane", () => {
    const bus = new FlatBus(0x100);
    bus.write32(0x00, 0x12345678);
    expect(bus.read32(0x00) >>> 0).toBe(0x12345678);
    // Sanity: byte 0 == low byte
    expect(bus.read8(0)).toBe(0x78);
  });
});
