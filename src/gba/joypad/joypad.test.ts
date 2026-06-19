import { describe, expect, it } from "vitest";

import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import { Joypad } from "./joypad.js";

describe("Joypad — KEYINPUT", () => {
  it("reads as all-released (low 10 bits set, reserved bits 10-15 = 0) on power-up", () => {
    const jp = new Joypad();
    // All 10 button bits = 1 (released); unused bits 10-15 read 0 → 0x03FF.
    expect(jp.keyinput()).toBe(0x03ff);
  });

  it("press(button) clears the corresponding KEYINPUT bit (active-low)", () => {
    const jp = new Joypad();
    jp.press("a");
    expect(jp.keyinput() & 0x0001).toBe(0); // bit 0 = A
    expect(jp.keyinput() & 0x03fe).toBe(0x03fe); // every other button bit still set
  });

  it("release(button) restores the bit", () => {
    const jp = new Joypad();
    jp.press("start");
    expect(jp.keyinput() & (1 << 3)).toBe(0);
    jp.release("start");
    expect(jp.keyinput() & (1 << 3)).toBe(1 << 3);
  });

  it("each button maps to its documented KEYINPUT bit position", () => {
    const cases: [import("./joypad.js").GbaButton, number][] = [
      ["a", 0],
      ["b", 1],
      ["select", 2],
      ["start", 3],
      ["right", 4],
      ["left", 5],
      ["up", 6],
      ["down", 7],
      ["r", 8],
      ["l", 9]
    ];
    for (const [btn, bit] of cases) {
      const jp = new Joypad();
      jp.press(btn);
      expect(jp.keyinput() & (1 << bit)).toBe(0);
      expect(jp.keyinput() | (1 << bit)).toBe(0x03ff);
    }
  });

  it("simultaneous presses combine in KEYINPUT", () => {
    const jp = new Joypad();
    jp.press("a");
    jp.press("right");
    jp.press("up");
    const ki = jp.keyinput();
    // Bits 0, 4, 6 cleared.
    const expected = 0x03ff & ~((1 << 0) | (1 << 4) | (1 << 6));
    expect(ki).toBe(expected);
  });

  it("KEYINPUT writes are ignored (register is read-only)", () => {
    const jp = new Joypad();
    jp.write16(0x00, 0x0000); // attempt to claim every button pressed
    expect(jp.keyinput()).toBe(0x03ff); // no buttons actually pressed
  });

  it("isPressed mirrors press/release state", () => {
    const jp = new Joypad();
    expect(jp.isPressed("a")).toBe(false);
    jp.press("a");
    expect(jp.isPressed("a")).toBe(true);
    jp.release("a");
    expect(jp.isPressed("a")).toBe(false);
  });
});

describe("Joypad — KEYCNT", () => {
  it("round-trips 16-bit writes", () => {
    const jp = new Joypad();
    jp.write16(0x02, 0xc1ff);
    expect(jp.read16(0x02)).toBe(0xc1ff);
  });

  it("starts at 0", () => {
    const jp = new Joypad();
    expect(jp.read16(0x02)).toBe(0);
  });

  it("byte writes land in the right half", () => {
    const jp = new Joypad();
    jp.write8(0x02, 0xaa); // low byte
    jp.write8(0x03, 0xbb); // high byte
    expect(jp.read16(0x02)).toBe(0xbbaa);
  });
});

describe("MappedBus + Joypad wiring", () => {
  it("CPU read at 0x04000130 reaches Joypad.read16", () => {
    const mem = makeGbaMemoryMap();
    mem.joypad.press("b");
    expect(mem.bus.read16(0x04000130)).toBe(mem.joypad.keyinput());
    expect(mem.bus.read16(0x04000130) & (1 << 1)).toBe(0); // B held
  });

  it("CPU write at 0x04000132 lands in KEYCNT (KEYINPUT stays read-only)", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000132, 0x4001);
    expect(mem.bus.read16(0x04000132)).toBe(0x4001);
    // KEYINPUT writes silently dropped.
    mem.bus.write16(0x04000130, 0x0000);
    expect(mem.bus.read16(0x04000130)).toBe(0x03ff);
  });
});

describe("Joypad — keypad IRQ (KEYCNT)", () => {
  const KEYCNT = 0x02;
  const ENABLE = 1 << 14;
  const AND = 1 << 15;
  const IRQ_KEYPAD = 12;

  function withIrq(): { jp: Joypad; raised: number[] } {
    const jp = new Joypad();
    const raised: number[] = [];
    (jp as unknown as { interrupts: { raise: (s: number) => void } }).interrupts = { raise: (s) => raised.push(s) };
    return { jp, raised };
  }

  it("AND-mode with an empty key mask is vacuously true — fires on the KEYCNT write (AGB aging cart)", () => {
    const { jp, raised } = withIrq();
    jp.write16(KEYCNT, ENABLE | AND); // mask 0, AND, IRQ enabled
    expect(raised).toEqual([IRQ_KEYPAD]);
  });

  it("OR-mode fires when any selected key is pressed, not before", () => {
    const { jp, raised } = withIrq();
    jp.write16(KEYCNT, ENABLE | (1 << 0)); // OR, select A
    expect(raised).toEqual([]);
    jp.press("a");
    expect(raised).toEqual([IRQ_KEYPAD]);
  });

  it("AND-mode fires only once all selected keys are pressed", () => {
    const { jp, raised } = withIrq();
    jp.write16(KEYCNT, ENABLE | AND | (1 << 0) | (1 << 1)); // need A AND B
    jp.press("a");
    expect(raised).toEqual([]);
    jp.press("b");
    expect(raised).toEqual([IRQ_KEYPAD]);
  });

  it("does not fire when IRQ enable (bit 14) is clear", () => {
    const { jp, raised } = withIrq();
    jp.write16(KEYCNT, AND); // condition true but IRQ disabled
    jp.press("a");
    expect(raised).toEqual([]);
  });

  it("edge-triggered: a condition that stays true fires once, not on every key change", () => {
    const { jp, raised } = withIrq();
    jp.write16(KEYCNT, ENABLE | (1 << 0)); // OR, select A
    jp.press("a"); // rising edge → fires
    jp.press("b"); // still matched (A held) → no new edge
    expect(raised).toEqual([IRQ_KEYPAD]);
  });
});
