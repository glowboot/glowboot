import { describe, expect, it } from "vitest";

import { SnesJoypad } from "./joypad.js";

describe("SnesJoypad", () => {
  it("maps buttons to the JOY1 bit layout", () => {
    const j = new SnesJoypad();
    j.press("b");
    j.press("start");
    j.press("a");
    j.press("r");
    expect(j.buttons).toBe(0x8000 | 0x1000 | 0x0080 | 0x0010);
    j.release("b");
    expect(j.buttons).toBe(0x1000 | 0x0080 | 0x0010);
  });

  it("releaseAll clears held buttons but keeps the raw overlay", () => {
    const j = new SnesJoypad();
    j.press("up");
    j.setRaw(0x0100); // right, driven headlessly
    j.releaseAll();
    expect(j.buttons).toBe(0x0100);
    j.setRaw(0);
    expect(j.buttons).toBe(0);
  });

  it("press and raw overlay combine", () => {
    const j = new SnesJoypad();
    j.setRaw(0x1000);
    j.press("y");
    expect(j.buttons).toBe(0x5000);
  });
});
