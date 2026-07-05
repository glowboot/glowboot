import { describe, expect, it } from "vitest";

import { C4_COS, C4_SIN } from "./cx4-tables.js";

describe("Cx4 sine/cosine tables", () => {
  it("has 512 entries each", () => {
    expect(C4_SIN.length).toBe(512);
    expect(C4_COS.length).toBe(512);
  });

  it("hits the cardinal values (Q15, 512 units per turn)", () => {
    expect(C4_SIN[0]).toBe(0); // sin(0)
    expect(C4_SIN[128]).toBe(32767); // sin(90°) saturates at +1
    expect(C4_SIN[256]).toBe(0); // sin(180°)
    expect(C4_SIN[384]).toBe(-32767); // sin(270°)
    expect(C4_COS[0]).toBe(32767); // cos(0)
    expect(C4_COS[128]).toBe(0); // cos(90°)
    expect(C4_COS[256]).toBe(-32767); // cos(180°)
  });

  it("matches sin(2*pi*i/512) in Q15 at spot points", () => {
    for (const i of [1, 40, 90, 200, 333, 500]) {
      const expected = Math.round(Math.sin((2 * Math.PI * i) / 512) * 32767);
      expect(Math.abs(C4_SIN[i]! - expected)).toBeLessThanOrEqual(1);
    }
  });

  it("cos leads sin by a quarter turn (cos[i] == sin[i+128])", () => {
    for (const i of [0, 1, 63, 128, 200, 400]) {
      expect(C4_COS[i]).toBe(C4_SIN[(i + 128) & 0x1ff]);
    }
  });

  it("rises monotonically through the first quarter turn", () => {
    for (let i = 1; i <= 128; i++) {
      expect(C4_SIN[i]!).toBeGreaterThanOrEqual(C4_SIN[i - 1]!);
    }
  });
});
