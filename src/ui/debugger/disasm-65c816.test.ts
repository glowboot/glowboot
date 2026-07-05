import { describe, expect, it } from "vitest";

import { disassemble65c816 } from "./disasm-65c816.js";

function peekOf(bytes: number[]): (addr: number) => number {
  return (addr: number) => bytes[addr & 0xffff] ?? 0;
}

describe("disassemble65c816", () => {
  it("widens LDA #imm with the M flag", () => {
    const peek = peekOf([0xa9, 0x12, 0x34]);
    expect(disassemble65c816(peek, 0, 0, true, true)).toEqual({ text: "LDA #$12", length: 2 });
    expect(disassemble65c816(peek, 0, 0, false, true)).toEqual({ text: "LDA #$3412", length: 3 });
  });

  it("widens LDX #imm with the X flag", () => {
    const peek = peekOf([0xa2, 0x12, 0x34]);
    expect(disassemble65c816(peek, 0, 0, true, true)).toEqual({ text: "LDX #$12", length: 2 });
    expect(disassemble65c816(peek, 0, 0, true, false)).toEqual({ text: "LDX #$3412", length: 3 });
  });

  it("computes branch targets relative to the byte after the operand", () => {
    const forward = peekOf([0x80, 0x10]);
    expect(disassemble65c816(forward, 0, 0x0000, true, true)).toEqual({ text: "BRA $0012", length: 2 });
    const backward = peekOf([0xd0, 0xfc]);
    expect(disassemble65c816(backward, 0, 0x0000, true, true)).toEqual({ text: "BNE $FFFE", length: 2 });
  });

  it("formats JSL long operands", () => {
    const peek = peekOf([0x22, 0x56, 0x34, 0x12]);
    expect(disassemble65c816(peek, 0, 0, true, true)).toEqual({ text: "JSL $123456", length: 4 });
  });

  it("renders MVN with the source bank first despite dst-first object code", () => {
    const peek = peekOf([0x54, 0x01, 0x02]);
    expect(disassemble65c816(peek, 0, 0, true, true)).toEqual({ text: "MVN $02,$01", length: 3 });
  });

  it("decodes all 256 opcodes to nonempty text with length 1-4", () => {
    for (let op = 0; op < 256; op++) {
      const peek = peekOf([op, 0x00, 0x00, 0x00]);
      for (const m8 of [true, false]) {
        for (const x8 of [true, false]) {
          const d = disassemble65c816(peek, 0, 0, m8, x8);
          expect(d.text).toMatch(/^[A-Z]{3}/);
          expect(d.length).toBeGreaterThanOrEqual(1);
          expect(d.length).toBeLessThanOrEqual(4);
        }
      }
    }
  });
});
