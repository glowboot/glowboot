import { describe, expect, it } from "vitest";

import { Obc1 } from "./obc1.js";

describe("Obc1", () => {
  const window = (n: number) => 0x6000 + n; // $1ffX register at window offset

  it("scatters the four low-OAM bytes by sprite index and base", () => {
    const ram = new Uint8Array(0x2000);
    const obc1 = new Obc1(ram);
    obc1.write(window(0x1ff5), 0x00); // base $1c00
    obc1.write(window(0x1ff6), 0x03); // sprite index 3 (shift = (3&3)<<1 = 6)
    obc1.write(window(0x1ff0), 0xaa);
    obc1.write(window(0x1ff1), 0xbb);
    obc1.write(window(0x1ff2), 0xcc);
    obc1.write(window(0x1ff3), 0xdd);
    const base = 0x1c00 + (3 << 2);
    expect(ram[base + 0]).toBe(0xaa);
    expect(ram[base + 1]).toBe(0xbb);
    expect(ram[base + 2]).toBe(0xcc);
    expect(ram[base + 3]).toBe(0xdd);
    expect(obc1.read(window(0x1ff0))).toBe(0xaa);
    expect(obc1.read(window(0x1ff2))).toBe(0xcc);
  });

  it("packs the two high-OAM bits into the shared table at $1ff4", () => {
    const ram = new Uint8Array(0x2000);
    const obc1 = new Obc1(ram);
    obc1.write(window(0x1ff5), 0x01); // base $1800
    // Four sprites share one packing byte at base + (index>>2) + 0x200.
    obc1.write(window(0x1ff6), 0x00); // index 0 → shift 0
    obc1.write(window(0x1ff4), 0x03);
    obc1.write(window(0x1ff6), 0x01); // index 1 → shift 2
    obc1.write(window(0x1ff4), 0x02);
    obc1.write(window(0x1ff6), 0x03); // index 3 → shift 6
    obc1.write(window(0x1ff4), 0x01);
    const ptr = 0x1800 + (0 >> 2) + 0x200;
    expect(ram[ptr]).toBe(0b01_00_10_11);
  });

  it("passes plain SRAM addresses straight through", () => {
    const ram = new Uint8Array(0x2000);
    const obc1 = new Obc1(ram);
    obc1.write(window(0x0123), 0x5a);
    expect(ram[0x0123]).toBe(0x5a);
    expect(obc1.read(window(0x0123))).toBe(0x5a);
  });

  it("recomputes its latches from persisted SRAM on reset", () => {
    const ram = new Uint8Array(0x2000);
    ram[0x1ff5] = 0x01; // base $1800
    ram[0x1ff6] = 0x05; // index 5, shift (5&3)<<1 = 2
    const obc1 = new Obc1(ram);
    obc1.write(window(0x1ff0), 0x77);
    expect(ram[0x1800 + (5 << 2) + 0]).toBe(0x77);
  });
});
