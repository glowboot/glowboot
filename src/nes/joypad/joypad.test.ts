import { beforeEach, describe, expect, it } from "vitest";

import { Joypad, type NesButton } from "./joypad.js";

/** $4016 shift order: A is bit 0, Right is bit 7. */
const BIT: Record<NesButton, number> = {
  a: 0x01,
  b: 0x02,
  select: 0x04,
  start: 0x08,
  up: 0x10,
  down: 0x20,
  left: 0x40,
  right: 0x80
};

const ALL_BUTTONS = Object.keys(BIT) as NesButton[];

describe("Joypad", () => {
  let joypad: Joypad;

  beforeEach(() => {
    joypad = new Joypad();
  });

  it("starts with no buttons pressed", () => {
    expect(joypad.buttons).toBe(0);
  });

  describe("press()", () => {
    for (const button of ALL_BUTTONS) {
      it(`sets the $4016 shift bit for "${button}"`, () => {
        joypad.press(button);
        expect(joypad.buttons).toBe(BIT[button]);
      });
    }

    it("ORs additional presses without clearing held buttons", () => {
      joypad.press("a");
      joypad.press("right");
      expect(joypad.buttons).toBe(BIT.a | BIT.right);
    });

    it("is idempotent while a button is held", () => {
      joypad.press("start");
      joypad.press("start");
      expect(joypad.buttons).toBe(BIT.start);
    });

    it("can hold all eight buttons at once", () => {
      for (const button of ALL_BUTTONS) joypad.press(button);
      expect(joypad.buttons).toBe(0xff);
    });
  });

  describe("release()", () => {
    for (const button of ALL_BUTTONS) {
      it(`clears only the bit for "${button}"`, () => {
        for (const b of ALL_BUTTONS) joypad.press(b);
        joypad.release(button);
        expect(joypad.buttons).toBe(0xff & ~BIT[button]);
      });
    }

    it("is a no-op when the button is not held", () => {
      joypad.press("a");
      joypad.release("b");
      expect(joypad.buttons).toBe(BIT.a);
    });

    it("leaves other held buttons untouched", () => {
      joypad.press("up");
      joypad.press("down");
      joypad.release("up");
      expect(joypad.buttons).toBe(BIT.down);
    });
  });

  describe("releaseAll()", () => {
    it("clears the entire bitfield", () => {
      for (const button of ALL_BUTTONS) joypad.press(button);
      joypad.releaseAll();
      expect(joypad.buttons).toBe(0);
    });

    it("is a no-op when nothing is held", () => {
      joypad.releaseAll();
      expect(joypad.buttons).toBe(0);
    });
  });

  describe("setState()", () => {
    it("overwrites the whole bitfield, dropping previously held buttons", () => {
      joypad.press("a");
      joypad.setState(BIT.left | BIT.right);
      expect(joypad.buttons).toBe(BIT.left | BIT.right);
    });

    it("masks the value to the low 8 bits", () => {
      joypad.setState(0x1ff);
      expect(joypad.buttons).toBe(0xff);
    });

    it("can clear all buttons", () => {
      joypad.press("start");
      joypad.setState(0);
      expect(joypad.buttons).toBe(0);
    });
  });

  describe("buttons getter / $4016 shift order", () => {
    it("matches the A=bit0 … Right=bit7 sequence", () => {
      const order: NesButton[] = ["a", "b", "select", "start", "up", "down", "left", "right"];
      order.forEach((button, index) => {
        joypad.releaseAll();
        joypad.press(button);
        expect(joypad.buttons).toBe(1 << index);
      });
    });
  });
});
