import { describe, expect, it } from "vitest";

import { Dsp1 } from "./dsp1.js";

/** Drive the DR port like a game does: command byte, then parameter words
 *  LSB-first, then read result words LSB-first. */
function runCommand(dsp: Dsp1, command: number, params: number[], resultWords: number): number[] {
  dsp.setDr(command);
  for (const p of params) {
    dsp.setDr(p & 0xff);
    dsp.setDr((p >> 8) & 0xff);
  }
  const out: number[] = [];
  for (let i = 0; i < resultWords; i++) {
    const lo = dsp.getDr();
    const hi = dsp.getDr();
    out.push(((lo | (hi << 8)) << 16) >> 16);
  }
  return out;
}

describe("DSP-1 coprocessor", () => {
  it("reports the DSP-1B ROM version via command $2F", () => {
    const dsp = new Dsp1();
    expect(runCommand(dsp, 0x2f, [0x0000], 1)).toEqual([0x0101]);
  });

  it("multiplies as (a*b)>>15 via command $00", () => {
    const dsp = new Dsp1();
    expect(runCommand(dsp, 0x00, [0x4000, 0x4000], 1)).toEqual([0x2000]); // 0.5 * 0.5 = 0.25
    // Q15 "one" is 32767/32768, so 1*1 lands one ULP short of itself.
    expect(runCommand(dsp, 0x00, [0x7fff, 0x7fff], 1)).toEqual([0x7ffe]);
    expect(runCommand(dsp, 0x00, [-0x4000 & 0xffff, 0x4000], 1)[0]).toBe(-0x2000);
  });

  it("computes triangle (sin/cos scaled by radius) via command $04", () => {
    const dsp = new Dsp1();
    // Angle 0: sin=0, cos=+1 (0x7fff) — Y=0, X≈radius.
    expect(runCommand(dsp, 0x04, [0, 0x7fff], 2)).toEqual([0, 0x7ffe]);
    // Angle $4000 = 90°: sin=+1, cos=0 — Y≈radius, X=0.
    const [y, x] = runCommand(new Dsp1(), 0x04, [0x4000, 0x4000], 2);
    expect(y).toBe(0x3fff);
    expect(x).toBe(0);
  });

  it("computes the inverse in normalized floating point via command $10", () => {
    const dsp = new Dsp1();
    // 1/(0.5 * 2^0): coefficient 0.5 normalizes exactly -> 2.0 = ~1*2^1.
    const [c, e] = runCommand(dsp, 0x10, [0x4000, 0x0000], 2);
    expect(c).toBe(0x7fff);
    expect(e).toBe(1);
    // Division by zero saturates.
    expect(runCommand(new Dsp1(), 0x10, [0, 0], 2)).toEqual([0x7fff, 0x002f]);
  });

  it("computes the squared radius as a 32-bit result via command $08", () => {
    const dsp = new Dsp1();
    const [lo, hi] = runCommand(dsp, 0x08, [0x0100, 0x0200, 0x0300], 2);
    const radius = ((hi! << 16) | (lo! & 0xffff)) >>> 0;
    expect(radius).toBe((0x0100 * 0x0100 + 0x0200 * 0x0200 + 0x0300 * 0x0300) * 2);
  });

  it("terminates commands with $80 in the data register and re-arms", () => {
    const dsp = new Dsp1();
    runCommand(dsp, 0x00, [0x1000, 0x1000], 1);
    // After the last result word the DR presents $0080; idle reads in the
    // wait state keep returning the low byte (no 16-bit toggle until a
    // command begins).
    expect(dsp.getDr()).toBe(0x80);
    expect(dsp.getDr()).toBe(0x80);
    expect(runCommand(dsp, 0x2f, [0], 1)).toEqual([0x0101]);
  });

  it("rotates coordinates clockwise via command $0C", () => {
    // Rotating (X=0x2000, Y=0) by 90° gives X2≈0, Y2≈-0x2000 (one ULP
    // short: Q15 sin(90°) is 32767/32768).
    const [x2, y2] = runCommand(new Dsp1(), 0x0c, [0x4000, 0x2000, 0], 2);
    expect(x2).toBe(0);
    expect(y2).toBe(-0x1fff);
  });
});
