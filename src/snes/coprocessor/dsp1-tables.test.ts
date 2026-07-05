import { describe, expect, it } from "vitest";

import { DATA_ROM, MAX_AZS_EXP, MUL_TABLE, SIN_TABLE } from "./dsp1-tables.js";

describe("DSP-1 data tables", () => {
  it("has the documented sizes", () => {
    expect(SIN_TABLE.length).toBe(256);
    expect(MUL_TABLE.length).toBe(256);
    expect(DATA_ROM.length).toBe(1024);
    expect(MAX_AZS_EXP.length).toBe(16);
  });

  it("sin table matches sin(2*pi*i/256) in Q15 at spot points", () => {
    expect(SIN_TABLE[0]).toBe(0);
    expect(SIN_TABLE[0x40]).toBe(0x7fff); // sin(90°) saturates at +1
    for (const i of [1, 7, 33, 63]) {
      const expected = Math.round(Math.sin((2 * Math.PI * i) / 256) * 32768);
      expect(Math.abs(SIN_TABLE[i]! - expected)).toBeLessThanOrEqual(1);
    }
    // quarter-wave symmetry: sin(180°-x) = sin(x)
    expect(SIN_TABLE[0x50]).toBe(SIN_TABLE[0x30]);
  });

  it("first quarter of the sin table is monotonically increasing", () => {
    for (let i = 1; i <= 0x40; i++) {
      expect(SIN_TABLE[i]!).toBeGreaterThanOrEqual(SIN_TABLE[i - 1]!);
    }
  });
});
