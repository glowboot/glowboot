import { describe, expect, it } from "vitest";

import { decode } from "./disassembler.js";

/** Helper: drop the trailing two bytes when you don't care about them. */
function dec(b0: number, b1 = 0, b2 = 0, pc = 0): ReturnType<typeof decode> {
  return decode(b0, b1, b2, pc);
}

describe("disassembler", () => {
  describe("1-byte opcodes", () => {
    it("NOP", () => {
      const d = dec(0x00);
      expect(d.mnemonic).toBe("NOP");
      expect(d.operands).toBe("");
      expect(d.length).toBe(1);
      expect(d.targetAddr).toBeUndefined();
    });

    it("HALT / STOP / DI / EI", () => {
      expect(dec(0x76).mnemonic).toBe("HALT");
      expect(dec(0x10).mnemonic).toBe("STOP");
      expect(dec(0xf3).mnemonic).toBe("DI");
      expect(dec(0xfb).mnemonic).toBe("EI");
    });

    it("RET / RETI", () => {
      const ret = dec(0xc9);
      expect(ret.mnemonic).toBe("RET");
      expect(ret.length).toBe(1);
      const reti = dec(0xd9);
      expect(reti.mnemonic).toBe("RETI");
      expect(reti.length).toBe(1);
    });
  });

  describe("LD r, r' block (0x40–0x7F)", () => {
    it("LD B, C (0x41)", () => {
      const d = dec(0x41);
      expect(d.mnemonic).toBe("LD");
      expect(d.operands).toBe("B, C");
      expect(d.length).toBe(1);
    });

    it("LD A, (HL) (0x7E)", () => {
      const d = dec(0x7e);
      expect(d.mnemonic).toBe("LD");
      expect(d.operands).toBe("A, (HL)");
    });

    it("LD (HL), B (0x70)", () => {
      const d = dec(0x70);
      expect(d.mnemonic).toBe("LD");
      expect(d.operands).toBe("(HL), B");
    });

    it("0x76 in the LD block is HALT, not LD (HL), (HL)", () => {
      expect(dec(0x76).mnemonic).toBe("HALT");
    });
  });

  describe("ALU block (0x80–0xBF)", () => {
    it("ADD A, B (0x80)", () => {
      const d = dec(0x80);
      expect(d.mnemonic).toBe("ADD");
      expect(d.operands).toBe("A, B");
    });

    it("XOR A (0xAF) — `A,` prefix dropped by tradition for XOR/OR/AND/SUB/CP", () => {
      const d = dec(0xaf);
      expect(d.mnemonic).toBe("XOR");
      expect(d.operands).toBe("A");
    });

    it("CP (HL) (0xBE) — same convention", () => {
      const d = dec(0xbe);
      expect(d.mnemonic).toBe("CP");
      expect(d.operands).toBe("(HL)");
    });

    it("ADC A, D (0x8A) — keeps the `A,` prefix for ADC/ADD/SBC", () => {
      const d = dec(0x8a);
      expect(d.mnemonic).toBe("ADC");
      expect(d.operands).toBe("A, D");
    });
  });

  describe("immediate operands", () => {
    it("LD A, n8 (0x3E)", () => {
      const d = dec(0x3e, 0x42);
      expect(d.mnemonic).toBe("LD");
      expect(d.operands).toBe("A, $42");
      expect(d.length).toBe(2);
    });

    it("LD BC, n16 (0x01)", () => {
      const d = dec(0x01, 0x34, 0x12);
      expect(d.mnemonic).toBe("LD");
      expect(d.operands).toBe("BC, $1234");
      expect(d.length).toBe(3);
    });

    it("LD SP, n16 (0x31)", () => {
      const d = dec(0x31, 0xfe, 0xff);
      expect(d.operands).toBe("SP, $FFFE");
    });

    it("LD (a16), SP (0x08) — targetAddr is the pointer destination", () => {
      const d = dec(0x08, 0x00, 0xc0);
      expect(d.operands).toBe("($C000), SP");
      expect(d.targetAddr).toBe(0xc000);
      expect(d.length).toBe(3);
    });
  });

  describe("flow-control absolute targets", () => {
    it("JP a16 (0xC3)", () => {
      const d = dec(0xc3, 0x50, 0x01);
      expect(d.mnemonic).toBe("JP");
      expect(d.operands).toBe("$0150");
      expect(d.targetAddr).toBe(0x0150);
      expect(d.length).toBe(3);
    });

    it("CALL a16 (0xCD)", () => {
      const d = dec(0xcd, 0x8c, 0x4a);
      expect(d.mnemonic).toBe("CALL");
      expect(d.operands).toBe("$4A8C");
      expect(d.targetAddr).toBe(0x4a8c);
    });

    it("CALL NZ, a16 (0xC4) has the condition prefix", () => {
      const d = dec(0xc4, 0x8c, 0x4a);
      expect(d.operands).toBe("NZ, $4A8C");
      expect(d.targetAddr).toBe(0x4a8c);
    });
  });

  describe("JR relative — resolves to absolute target", () => {
    it("JR +2 from PC=$0150 lands at $0154 (pc + 2 + 2)", () => {
      const d = dec(0x18, 0x02, 0, 0x0150);
      expect(d.mnemonic).toBe("JR");
      expect(d.operands).toBe("$0154");
      expect(d.targetAddr).toBe(0x0154);
      expect(d.length).toBe(2);
    });

    it("JR -2 (0xFE offset) from PC=$0150 lands at $0150 (infinite loop)", () => {
      const d = dec(0x18, 0xfe, 0, 0x0150);
      expect(d.targetAddr).toBe(0x0150);
    });

    it("JR NZ, r8 (0x20)", () => {
      const d = dec(0x20, 0x05, 0, 0x0100);
      expect(d.operands).toBe("NZ, $0107");
      expect(d.targetAddr).toBe(0x0107);
    });

    it("wraps 16-bit on overflow", () => {
      const d = dec(0x18, 0x10, 0, 0xfff0);
      expect(d.targetAddr).toBe(0x0002);
    });
  });

  describe("RST vectors", () => {
    it("RST $00 (0xC7)", () => {
      const d = dec(0xc7);
      expect(d.mnemonic).toBe("RST");
      expect(d.operands).toBe("$00");
      expect(d.targetAddr).toBe(0x00);
      expect(d.length).toBe(1);
    });

    it("RST $38 (0xFF)", () => {
      const d = dec(0xff);
      expect(d.operands).toBe("$38");
      expect(d.targetAddr).toBe(0x38);
    });
  });

  describe("LDH and absolute memory refs", () => {
    it("LDH (a8), A (0xE0) maps to $FF00+a8", () => {
      const d = dec(0xe0, 0x44);
      expect(d.mnemonic).toBe("LDH");
      expect(d.operands).toBe("($FF44), A");
      expect(d.targetAddr).toBe(0xff44);
      expect(d.length).toBe(2);
    });

    it("LD (a16), A (0xEA)", () => {
      const d = dec(0xea, 0x00, 0xc0);
      expect(d.operands).toBe("($C000), A");
      expect(d.targetAddr).toBe(0xc000);
      expect(d.length).toBe(3);
    });
  });

  describe("unused / prohibited opcodes render as DB", () => {
    it.each([0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd])("0x%s → DB", (op) => {
      const d = dec(op);
      expect(d.mnemonic).toBe("DB");
      expect(d.operands).toMatch(/^\$[0-9A-F]{2}$/);
      expect(d.length).toBe(1);
    });
  });

  describe("CB-prefixed opcodes", () => {
    it("always report length=2", () => {
      for (let b1 = 0; b1 < 256; b1++) {
        const d = dec(0xcb, b1);
        expect(d.length).toBe(2);
      }
    });

    it("RLC B (0xCB 0x00)", () => {
      const d = dec(0xcb, 0x00);
      expect(d.mnemonic).toBe("RLC");
      expect(d.operands).toBe("B");
    });

    it("SWAP A (0xCB 0x37)", () => {
      const d = dec(0xcb, 0x37);
      expect(d.mnemonic).toBe("SWAP");
      expect(d.operands).toBe("A");
    });

    it("BIT 7, H (0xCB 0x7C)", () => {
      const d = dec(0xcb, 0x7c);
      expect(d.mnemonic).toBe("BIT");
      expect(d.operands).toBe("7, H");
    });

    it("RES 0, B (0xCB 0x80)", () => {
      const d = dec(0xcb, 0x80);
      expect(d.mnemonic).toBe("RES");
      expect(d.operands).toBe("0, B");
    });

    it("SET 7, A (0xCB 0xFF)", () => {
      const d = dec(0xcb, 0xff);
      expect(d.mnemonic).toBe("SET");
      expect(d.operands).toBe("7, A");
    });
  });

  describe("decoder exhaustiveness", () => {
    it("decodes every one-byte primary opcode without throwing", () => {
      for (let op = 0; op < 256; op++) {
        const d = dec(op, 0x00, 0x00);
        expect(d.length).toBeGreaterThanOrEqual(1);
        expect(d.length).toBeLessThanOrEqual(3);
        expect(d.mnemonic.length).toBeGreaterThan(0);
      }
    });

    it("decodes every CB-prefixed opcode without throwing", () => {
      for (let b1 = 0; b1 < 256; b1++) {
        const d = dec(0xcb, b1);
        expect(d.length).toBe(2);
        expect(d.mnemonic.length).toBeGreaterThan(0);
      }
    });
  });
});
