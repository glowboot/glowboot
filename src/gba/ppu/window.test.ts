import { describe, expect, it } from "vitest";

import { buildWindowMask, windowsActive } from "./window.js";

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 160;
const SCREEN_PIXELS = SCREEN_WIDTH * SCREEN_HEIGHT;

function makeMask(): Uint8Array {
  return new Uint8Array(SCREEN_PIXELS);
}

function packRect(x1: number, x2: number): number {
  return ((x1 & 0xff) << 8) | (x2 & 0xff);
}

describe("windowsActive", () => {
  it("returns false when none of DISPCNT bits 13/14/15 are set", () => {
    expect(windowsActive(0)).toBe(false);
    expect(windowsActive(0x0fff)).toBe(false); // bits 0-11 set
  });

  it("returns true for any of WIN0 / WIN1 / OBJWIN bits", () => {
    expect(windowsActive(1 << 13)).toBe(true);
    expect(windowsActive(1 << 14)).toBe(true);
    expect(windowsActive(1 << 15)).toBe(true);
  });
});

describe("buildWindowMask — single window in a clean rectangle", () => {
  it("WIN0 contains pixels inside its rectangle, WINOUT outside", () => {
    const mask = makeMask();
    const dispcnt = 1 << 13; // WIN0 enabled
    // WIN0 = [10, 30) x [20, 40), WININ low byte = 0x05 (BG0 + BG2),
    // WINOUT low byte = 0x10 (OBJ only).
    buildWindowMask(dispcnt, packRect(10, 30), 0, packRect(20, 40), 0, 0x05, 0x10, null, mask);
    // Inside WIN0 — top-left corner.
    expect(mask[20 * SCREEN_WIDTH + 10]).toBe(0x05);
    // Inside WIN0 — middle.
    expect(mask[25 * SCREEN_WIDTH + 20]).toBe(0x05);
    // Just outside on the right edge (x2 exclusive).
    expect(mask[25 * SCREEN_WIDTH + 30]).toBe(0x10);
    // Just outside on the bottom edge (y2 exclusive).
    expect(mask[40 * SCREEN_WIDTH + 20]).toBe(0x10);
    // Far away → WINOUT.
    expect(mask[100 * SCREEN_WIDTH + 200]).toBe(0x10);
  });

  it("WIN1 takes effect when WIN0 isn't enabled, with WININ high byte", () => {
    const mask = makeMask();
    const dispcnt = 1 << 14; // WIN1 only
    buildWindowMask(
      dispcnt,
      0,
      packRect(5, 15),
      0,
      packRect(5, 15),
      0x07 << 8 /* WIN1 enable in high byte */,
      0x30,
      null,
      mask
    );
    expect(mask[10 * SCREEN_WIDTH + 10]).toBe(0x07);
    expect(mask[0]).toBe(0x30); // outside
  });
});

describe("buildWindowMask — priority ordering", () => {
  it("WIN0 wins over WIN1 where the rectangles overlap", () => {
    const mask = makeMask();
    const dispcnt = (1 << 13) | (1 << 14);
    // WIN0 = [0, 50) x [0, 50) with enable 0x01 (BG0).
    // WIN1 = [25, 75) x [25, 75) with enable 0x02 (BG1).
    buildWindowMask(
      dispcnt,
      packRect(0, 50),
      packRect(25, 75),
      packRect(0, 50),
      packRect(25, 75),
      0x01 | (0x02 << 8),
      0x04,
      null,
      mask
    );
    // Overlap region — WIN0 wins.
    expect(mask[30 * SCREEN_WIDTH + 30]).toBe(0x01);
    // WIN1-only region.
    expect(mask[60 * SCREEN_WIDTH + 60]).toBe(0x02);
    // Outside both.
    expect(mask[100 * SCREEN_WIDTH + 100]).toBe(0x04);
  });
});

describe("buildWindowMask — rectangle quirks", () => {
  it("X2 > 240 is treated as X2 = 240 (window extends to right edge)", () => {
    const mask = makeMask();
    buildWindowMask(1 << 13, packRect(100, 0xff), 0, packRect(0, 160), 0, 0x01, 0x02, null, mask);
    // x = 239 still inside.
    expect(mask[0 * SCREEN_WIDTH + 239]).toBe(0x01);
    // x = 99 just outside the left edge.
    expect(mask[0 * SCREEN_WIDTH + 99]).toBe(0x02);
  });

  it("X1 > X2 is normalised by clamping X2 to 240 (window from X1 to right edge)", () => {
    const mask = makeMask();
    buildWindowMask(1 << 13, packRect(200, 50), 0, packRect(0, 160), 0, 0x01, 0x02, null, mask);
    expect(mask[0 * SCREEN_WIDTH + 200]).toBe(0x01); // inside
    expect(mask[0 * SCREEN_WIDTH + 239]).toBe(0x01); // still inside (extends to edge)
    expect(mask[0 * SCREEN_WIDTH + 49]).toBe(0x02); // outside (the wrap "right" half is gone)
  });

  it("X1 == X2 with X1 < 240 → empty window (every pixel hits WINOUT)", () => {
    const mask = makeMask();
    buildWindowMask(1 << 13, packRect(100, 100), 0, packRect(0, 160), 0, 0x01, 0x02, null, mask);
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      expect(mask[0 * SCREEN_WIDTH + x]).toBe(0x02);
    }
  });

  it("Y axis follows the same clamping rules", () => {
    const mask = makeMask();
    // Y2 > 160 → clamp to 160.
    buildWindowMask(1 << 13, packRect(0, 240), 0, packRect(50, 0xff), 0, 0x01, 0x02, null, mask);
    expect(mask[159 * SCREEN_WIDTH + 0]).toBe(0x01); // bottom row, inside
    expect(mask[49 * SCREEN_WIDTH + 0]).toBe(0x02); // just above top
  });
});
