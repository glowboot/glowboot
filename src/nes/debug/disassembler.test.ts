import { describe, expect, it } from "vitest";

import { decode } from "./disassembler.js";

describe("6502 disassembler", () => {
  describe("addressing modes", () => {
    it("immediate", () => {
      expect(decode(0xa9, 0x44, 0, 0)).toEqual({
        mnemonic: "LDA",
        operands: "#$44",
        length: 2
      });
    });

    it("zero page (memory ref sets targetAddr)", () => {
      expect(decode(0xa5, 0x10, 0, 0)).toEqual({
        mnemonic: "LDA",
        operands: "$10",
        length: 2,
        targetAddr: 0x10
      });
    });

    it("zero page,X", () => {
      expect(decode(0xb5, 0x10, 0, 0)).toEqual({
        mnemonic: "LDA",
        operands: "$10,X",
        length: 2,
        targetAddr: 0x10
      });
    });

    it("zero page,Y", () => {
      expect(decode(0xb6, 0x10, 0, 0)).toEqual({
        mnemonic: "LDX",
        operands: "$10,Y",
        length: 2,
        targetAddr: 0x10
      });
    });

    it("(indirect,X)", () => {
      expect(decode(0xa1, 0x80, 0, 0)).toEqual({
        mnemonic: "LDA",
        operands: "($80,X)",
        length: 2
      });
    });

    it("(indirect),Y", () => {
      expect(decode(0xb1, 0x89, 0, 0)).toEqual({
        mnemonic: "LDA",
        operands: "($89),Y",
        length: 2
      });
    });

    it("absolute", () => {
      expect(decode(0xad, 0x00, 0x44, 0)).toEqual({
        mnemonic: "LDA",
        operands: "$4400",
        length: 3,
        targetAddr: 0x4400
      });
    });

    it("absolute,X", () => {
      expect(decode(0xbd, 0x00, 0x44, 0)).toEqual({
        mnemonic: "LDA",
        operands: "$4400,X",
        length: 3,
        targetAddr: 0x4400
      });
    });

    it("absolute,Y", () => {
      expect(decode(0xb9, 0x00, 0x44, 0)).toEqual({
        mnemonic: "LDA",
        operands: "$4400,Y",
        length: 3,
        targetAddr: 0x4400
      });
    });

    it("implied", () => {
      expect(decode(0xea, 0, 0, 0)).toEqual({ mnemonic: "NOP", operands: "", length: 1 });
    });

    it("accumulator", () => {
      expect(decode(0x0a, 0, 0, 0)).toEqual({ mnemonic: "ASL", operands: "A", length: 1 });
      expect(decode(0x4a, 0, 0, 0)).toEqual({ mnemonic: "LSR", operands: "A", length: 1 });
      expect(decode(0x2a, 0, 0, 0)).toEqual({ mnemonic: "ROL", operands: "A", length: 1 });
      expect(decode(0x6a, 0, 0, 0)).toEqual({ mnemonic: "ROR", operands: "A", length: 1 });
    });
  });

  describe("control flow & target resolution", () => {
    it("JMP absolute", () => {
      expect(decode(0x4c, 0xf5, 0xc5, 0xc000)).toEqual({
        mnemonic: "JMP",
        operands: "$C5F5",
        length: 3,
        targetAddr: 0xc5f5
      });
    });

    it("JMP indirect", () => {
      expect(decode(0x6c, 0x00, 0x02, 0)).toEqual({
        mnemonic: "JMP",
        operands: "($0200)",
        length: 3,
        targetAddr: 0x0200
      });
    });

    it("JSR", () => {
      expect(decode(0x20, 0x21, 0xc7, 0)).toEqual({
        mnemonic: "JSR",
        operands: "$C721",
        length: 3,
        targetAddr: 0xc721
      });
    });

    it("RTS / RTI / BRK are implied", () => {
      expect(decode(0x60, 0, 0, 0)).toEqual({ mnemonic: "RTS", operands: "", length: 1 });
      expect(decode(0x40, 0, 0, 0)).toEqual({ mnemonic: "RTI", operands: "", length: 1 });
      expect(decode(0x00, 0, 0, 0)).toEqual({ mnemonic: "BRK", operands: "", length: 1 });
    });

    it("relative branch resolves the forward target", () => {
      // BNE at $C100 with offset +4 → $C100 + 2 + 4 = $C106.
      expect(decode(0xd0, 0x04, 0, 0xc100)).toEqual({
        mnemonic: "BNE",
        operands: "$C106",
        length: 2,
        targetAddr: 0xc106
      });
    });

    it("relative branch resolves a backward (negative) target", () => {
      // BPL at $C100 with offset -5 ($FB) → $C100 + 2 - 5 = $C0FD.
      expect(decode(0x10, 0xfb, 0, 0xc100)).toEqual({
        mnemonic: "BPL",
        operands: "$C0FD",
        length: 2,
        targetAddr: 0xc0fd
      });
    });

    it("relative branch wraps at the 16-bit boundary", () => {
      // BEQ at $FFFE with offset +4 → ($FFFE + 2 + 4) & 0xFFFF = $0004.
      expect(decode(0xf0, 0x04, 0, 0xfffe)).toEqual({
        mnemonic: "BEQ",
        operands: "$0004",
        length: 2,
        targetAddr: 0x0004
      });
    });
  });

  describe("unofficial opcodes (prefixed with *)", () => {
    it("*LAX", () => {
      expect(decode(0xa3, 0x40, 0, 0)).toEqual({
        mnemonic: "*LAX",
        operands: "($40,X)",
        length: 2
      });
      expect(decode(0xa7, 0x10, 0, 0)).toEqual({
        mnemonic: "*LAX",
        operands: "$10",
        length: 2,
        targetAddr: 0x10
      });
    });

    it("*SAX", () => {
      expect(decode(0x83, 0x49, 0, 0)).toEqual({
        mnemonic: "*SAX",
        operands: "($49,X)",
        length: 2
      });
    });

    it("*DCP", () => {
      expect(decode(0xdf, 0x48, 0x05, 0)).toEqual({
        mnemonic: "*DCP",
        operands: "$0548,X",
        length: 3,
        targetAddr: 0x0548
      });
    });

    it("*ISC", () => {
      expect(decode(0xe7, 0x47, 0, 0)).toEqual({
        mnemonic: "*ISC",
        operands: "$47",
        length: 2,
        targetAddr: 0x47
      });
    });

    it("the unofficial NOPs are *NOP; the official NOP is NOP", () => {
      // 0x04 = unofficial zero-page NOP.
      expect(decode(0x04, 0xa9, 0, 0)).toEqual({
        mnemonic: "*NOP",
        operands: "$A9",
        length: 2,
        targetAddr: 0xa9
      });
      // 0x1A = unofficial implied NOP.
      expect(decode(0x1a, 0, 0, 0)).toEqual({ mnemonic: "*NOP", operands: "", length: 1 });
      // 0x80 = unofficial immediate NOP.
      expect(decode(0x80, 0x89, 0, 0)).toEqual({
        mnemonic: "*NOP",
        operands: "#$89",
        length: 2
      });
      // 0xEA = the official NOP — no star.
      expect(decode(0xea, 0, 0, 0)).toEqual({ mnemonic: "NOP", operands: "", length: 1 });
    });

    it("*SBC is the unofficial alias at 0xEB", () => {
      expect(decode(0xeb, 0x40, 0, 0)).toEqual({
        mnemonic: "*SBC",
        operands: "#$40",
        length: 2
      });
    });
  });

  describe("coverage", () => {
    it("decodes every one of the 256 opcode slots", () => {
      for (let op = 0; op <= 0xff; op++) {
        const d = decode(op, 0x12, 0x34, 0x8000);
        expect(d.mnemonic.length).toBeGreaterThan(0);
        expect([1, 2, 3]).toContain(d.length);
      }
    });
  });
});
