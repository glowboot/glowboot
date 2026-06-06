import { describe, expect, it } from "vitest";

import { cartHasGpioRtc } from "./rtc-detect.js";

function header(gameCode: string): { gameCode: string } {
  return { gameCode } as { gameCode: string };
}

describe("cartHasGpioRtc", () => {
  // The 3-letter prefix matches every region suffix, so checking one
  // per franchise is enough to lock in the detection contract.
  it("detects Pokémon Ruby (AXVE)", () => {
    expect(cartHasGpioRtc(header("AXVE") as never)).toBe(true);
  });
  it("detects Pokémon Sapphire (AXPE)", () => {
    expect(cartHasGpioRtc(header("AXPE") as never)).toBe(true);
  });
  it("detects Pokémon Emerald (BPEE)", () => {
    expect(cartHasGpioRtc(header("BPEE") as never)).toBe(true);
  });
  it("detects Pokémon FireRed (BPRE)", () => {
    expect(cartHasGpioRtc(header("BPRE") as never)).toBe(true);
  });
  it("detects Pokémon LeafGreen (BPGE)", () => {
    expect(cartHasGpioRtc(header("BPGE") as never)).toBe(true);
  });
  it("detects Boktai (U3IE)", () => {
    expect(cartHasGpioRtc(header("U3IE") as never)).toBe(true);
  });
  it("detects Boktai 2 (U32E)", () => {
    expect(cartHasGpioRtc(header("U32E") as never)).toBe(true);
  });
  it("detects Boktai 3 (U33J)", () => {
    expect(cartHasGpioRtc(header("U33J") as never)).toBe(true);
  });
  it("rejects Drill Dozer (V49E) — rumble cart, no RTC", () => {
    expect(cartHasGpioRtc(header("V49E") as never)).toBe(false);
  });
  it("rejects an arbitrary non-RTC cart", () => {
    expect(cartHasGpioRtc(header("AYWE") as never)).toBe(false);
  });
});
