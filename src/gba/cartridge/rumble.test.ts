import { describe, expect, it } from "vitest";

import { GPIO_BIT3 } from "./gpio.js";
import { cartHasGpioRumble, GpioRumble } from "./rumble.js";

function header(gameCode: string): { gameCode: string } {
  return { gameCode } as { gameCode: string };
}

describe("cartHasGpioRumble", () => {
  it("detects Drill Dozer USA (V49E)", () => {
    expect(cartHasGpioRumble(header("V49E") as never)).toBe(true);
  });
  it("detects Drill Dozer Europe (V49P)", () => {
    expect(cartHasGpioRumble(header("V49P") as never)).toBe(true);
  });
  it("detects Drill Dozer Japan (V49J)", () => {
    expect(cartHasGpioRumble(header("V49J") as never)).toBe(true);
  });
  it("detects WarioWare Twisted USA (RZWE) — rumble lives on the same GPIO bit alongside the gyroscope", () => {
    expect(cartHasGpioRumble(header("RZWE") as never)).toBe(true);
  });
  it("detects WarioWare Twisted Japan (RZWJ)", () => {
    expect(cartHasGpioRumble(header("RZWJ") as never)).toBe(true);
  });
  // Pokémon Emerald uses GPIO for RTC, not rumble. We must not detect
  // it as a rumble cart or every clock tick would vibrate the device.
  it("rejects Pokémon Emerald (BPEE) — RTC-only GPIO, no rumble", () => {
    expect(cartHasGpioRumble(header("BPEE") as never)).toBe(false);
  });
  it("rejects an arbitrary non-rumble cart", () => {
    expect(cartHasGpioRumble(header("AYWE") as never)).toBe(false);
  });
});

describe("GpioRumble feature", () => {
  it("forwards bit-3 transitions to the callback when bit 3 is CPU-driven", () => {
    const events: boolean[] = [];
    const r = new GpioRumble((on) => events.push(on));

    // Direction marks bit 3 as output (CPU drives).
    r.onDataWrite(GPIO_BIT3, GPIO_BIT3);
    r.onDataWrite(0, GPIO_BIT3);
    r.onDataWrite(GPIO_BIT3, GPIO_BIT3);
    expect(events).toEqual([true, false, true]);
  });

  it("ignores bit-3 writes when bit 3 is set as input (direction = 0)", () => {
    const events: boolean[] = [];
    const r = new GpioRumble((on) => events.push(on));

    r.onDataWrite(GPIO_BIT3, 0);
    r.onDataWrite(0, 0);
    expect(events).toEqual([]);
  });

  it("deduplicates repeated same-state writes", () => {
    const events: boolean[] = [];
    const r = new GpioRumble((on) => events.push(on));

    r.onDataWrite(GPIO_BIT3, GPIO_BIT3);
    r.onDataWrite(GPIO_BIT3, GPIO_BIT3);
    r.onDataWrite(GPIO_BIT3, GPIO_BIT3);
    expect(events).toEqual([true]);
  });

  it("readData returns 0 — rumble is write-only", () => {
    const r = new GpioRumble(() => {});
    expect(r.readData(0)).toBe(0);
    expect(r.readData(0xf)).toBe(0);
  });
});
