/**
 * LR35902 disassembler — maps up to three consecutive bytes into a
 * `DecodedInstruction`. Pure, no browser / engine dependencies, so it
 * runs in headless test suites or debuggers without pulling in the
 * rest of the engine.
 *
 * Covers every primary opcode (256) and every `0xCB`-prefixed opcode
 * (256 more) documented in the Pan Docs. Returns `length` (1-3 bytes
 * consumed) so callers can walk contiguous code; and `targetAddr`
 * for flow-control or memory-referencing ops so the UI can render
 * clickable jump / memory links.
 *
 * Formatting convention: `$XX` / `$XXXX` for hex literals (Game Boy
 * tradition), `r8`-relative offsets resolved to their absolute target
 * in the text so a reader doesn't have to do PC math.
 */

export interface DecodedInstruction {
  /** Human-readable mnemonic (e.g. `"LD"`, `"ADD"`, `"JR NZ"`). */
  readonly mnemonic: string;
  /** Operand string (e.g. `"A, $42"`, `"HL, $C000"`). Empty for ops
   *  with no operands (`NOP`, `RET`, `DI`). */
  readonly operands: string;
  /** Bytes consumed — always 1, 2, or 3 (or 2 for any CB-prefixed op). */
  readonly length: number;
  /** Absolute 16-bit address this instruction references, when
   *  meaningful — jump / call targets, `LD (nn),A`, `LDH ($FF00+n)`,
   *  etc. Undefined for register-only ops. */
  readonly targetAddr?: number;
}

/** Decode the instruction starting at `bytes[0]`. `pc` is the address
 *  of `bytes[0]`; needed to resolve relative-jump offsets to their
 *  absolute target. Callers pass 3 bytes (pad with 0 if short); the
 *  decoder tolerates missing trailing bytes by returning a 1-byte
 *  `DB` entry. */
export function decode(b0: number, b1: number, b2: number, pc: number): DecodedInstruction {
  b0 &= 0xff;
  b1 &= 0xff;
  b2 &= 0xff;
  if (b0 === 0xcb) return decodeCb(b1);
  return decodePrimary(b0, b1, b2, pc);
}

// ─── Primary opcode decoder ─────────────────────────────────────────

const REG8 = ["B", "C", "D", "E", "H", "L", "(HL)", "A"] as const;
const ALU = ["ADD", "ADC", "SUB", "SBC", "AND", "XOR", "OR", "CP"] as const;

function hex2(n: number): string {
  return "$" + (n & 0xff).toString(16).padStart(2, "0").toUpperCase();
}

function hex4(n: number): string {
  return "$" + (n & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

/** Sign-extend an 8-bit relative offset and add to (pc+2) to get
 *  the absolute JR / JR cc target. */
function relTarget(pc: number, rel: number): number {
  return (pc + 2 + ((rel << 24) >> 24)) & 0xffff;
}

function decodePrimary(b0: number, b1: number, b2: number, pc: number): DecodedInstruction {
  // Block 1: LD r, r'  (0x40-0x7F) — except 0x76 = HALT.
  if (b0 >= 0x40 && b0 <= 0x7f) {
    if (b0 === 0x76) return { mnemonic: "HALT", operands: "", length: 1 };
    const dst = REG8[(b0 >> 3) & 0x07]!;
    const src = REG8[b0 & 0x07]!;
    return { mnemonic: "LD", operands: `${dst}, ${src}`, length: 1 };
  }

  // Block 2: ALU A, r  (0x80-0xBF).
  if (b0 >= 0x80 && b0 <= 0xbf) {
    const op = ALU[(b0 >> 3) & 0x07]!;
    const src = REG8[b0 & 0x07]!;
    // CP / SUB / AND / OR / XOR conventionally drop the "A," prefix
    // in Game Boy tooling — but keep it for ADD / ADC / SBC so the
    // binary op is explicit.
    const withA = op === "ADD" || op === "ADC" || op === "SBC";
    return { mnemonic: op, operands: withA ? `A, ${src}` : src, length: 1 };
  }

  switch (b0) {
    // ─── 0x00-0x0F ─────────────────────────────────────────────────
    case 0x00:
      return { mnemonic: "NOP", operands: "", length: 1 };
    case 0x01:
      return { mnemonic: "LD", operands: `BC, ${hex4(b1 | (b2 << 8))}`, length: 3 };
    case 0x02:
      return { mnemonic: "LD", operands: "(BC), A", length: 1 };
    case 0x03:
      return { mnemonic: "INC", operands: "BC", length: 1 };
    case 0x04:
      return { mnemonic: "INC", operands: "B", length: 1 };
    case 0x05:
      return { mnemonic: "DEC", operands: "B", length: 1 };
    case 0x06:
      return { mnemonic: "LD", operands: `B, ${hex2(b1)}`, length: 2 };
    case 0x07:
      return { mnemonic: "RLCA", operands: "", length: 1 };
    case 0x08: {
      const addr = b1 | (b2 << 8);
      return { mnemonic: "LD", operands: `(${hex4(addr)}), SP`, length: 3, targetAddr: addr };
    }
    case 0x09:
      return { mnemonic: "ADD", operands: "HL, BC", length: 1 };
    case 0x0a:
      return { mnemonic: "LD", operands: "A, (BC)", length: 1 };
    case 0x0b:
      return { mnemonic: "DEC", operands: "BC", length: 1 };
    case 0x0c:
      return { mnemonic: "INC", operands: "C", length: 1 };
    case 0x0d:
      return { mnemonic: "DEC", operands: "C", length: 1 };
    case 0x0e:
      return { mnemonic: "LD", operands: `C, ${hex2(b1)}`, length: 2 };
    case 0x0f:
      return { mnemonic: "RRCA", operands: "", length: 1 };

    // ─── 0x10-0x1F ─────────────────────────────────────────────────
    case 0x10:
      return { mnemonic: "STOP", operands: "", length: 2 };
    case 0x11:
      return { mnemonic: "LD", operands: `DE, ${hex4(b1 | (b2 << 8))}`, length: 3 };
    case 0x12:
      return { mnemonic: "LD", operands: "(DE), A", length: 1 };
    case 0x13:
      return { mnemonic: "INC", operands: "DE", length: 1 };
    case 0x14:
      return { mnemonic: "INC", operands: "D", length: 1 };
    case 0x15:
      return { mnemonic: "DEC", operands: "D", length: 1 };
    case 0x16:
      return { mnemonic: "LD", operands: `D, ${hex2(b1)}`, length: 2 };
    case 0x17:
      return { mnemonic: "RLA", operands: "", length: 1 };
    case 0x18: {
      const t = relTarget(pc, b1);
      return { mnemonic: "JR", operands: hex4(t), length: 2, targetAddr: t };
    }
    case 0x19:
      return { mnemonic: "ADD", operands: "HL, DE", length: 1 };
    case 0x1a:
      return { mnemonic: "LD", operands: "A, (DE)", length: 1 };
    case 0x1b:
      return { mnemonic: "DEC", operands: "DE", length: 1 };
    case 0x1c:
      return { mnemonic: "INC", operands: "E", length: 1 };
    case 0x1d:
      return { mnemonic: "DEC", operands: "E", length: 1 };
    case 0x1e:
      return { mnemonic: "LD", operands: `E, ${hex2(b1)}`, length: 2 };
    case 0x1f:
      return { mnemonic: "RRA", operands: "", length: 1 };

    // ─── 0x20-0x2F ─────────────────────────────────────────────────
    case 0x20: {
      const t = relTarget(pc, b1);
      return { mnemonic: "JR", operands: `NZ, ${hex4(t)}`, length: 2, targetAddr: t };
    }
    case 0x21:
      return { mnemonic: "LD", operands: `HL, ${hex4(b1 | (b2 << 8))}`, length: 3 };
    case 0x22:
      return { mnemonic: "LD", operands: "(HL+), A", length: 1 };
    case 0x23:
      return { mnemonic: "INC", operands: "HL", length: 1 };
    case 0x24:
      return { mnemonic: "INC", operands: "H", length: 1 };
    case 0x25:
      return { mnemonic: "DEC", operands: "H", length: 1 };
    case 0x26:
      return { mnemonic: "LD", operands: `H, ${hex2(b1)}`, length: 2 };
    case 0x27:
      return { mnemonic: "DAA", operands: "", length: 1 };
    case 0x28: {
      const t = relTarget(pc, b1);
      return { mnemonic: "JR", operands: `Z, ${hex4(t)}`, length: 2, targetAddr: t };
    }
    case 0x29:
      return { mnemonic: "ADD", operands: "HL, HL", length: 1 };
    case 0x2a:
      return { mnemonic: "LD", operands: "A, (HL+)", length: 1 };
    case 0x2b:
      return { mnemonic: "DEC", operands: "HL", length: 1 };
    case 0x2c:
      return { mnemonic: "INC", operands: "L", length: 1 };
    case 0x2d:
      return { mnemonic: "DEC", operands: "L", length: 1 };
    case 0x2e:
      return { mnemonic: "LD", operands: `L, ${hex2(b1)}`, length: 2 };
    case 0x2f:
      return { mnemonic: "CPL", operands: "", length: 1 };

    // ─── 0x30-0x3F ─────────────────────────────────────────────────
    case 0x30: {
      const t = relTarget(pc, b1);
      return { mnemonic: "JR", operands: `NC, ${hex4(t)}`, length: 2, targetAddr: t };
    }
    case 0x31:
      return { mnemonic: "LD", operands: `SP, ${hex4(b1 | (b2 << 8))}`, length: 3 };
    case 0x32:
      return { mnemonic: "LD", operands: "(HL-), A", length: 1 };
    case 0x33:
      return { mnemonic: "INC", operands: "SP", length: 1 };
    case 0x34:
      return { mnemonic: "INC", operands: "(HL)", length: 1 };
    case 0x35:
      return { mnemonic: "DEC", operands: "(HL)", length: 1 };
    case 0x36:
      return { mnemonic: "LD", operands: `(HL), ${hex2(b1)}`, length: 2 };
    case 0x37:
      return { mnemonic: "SCF", operands: "", length: 1 };
    case 0x38: {
      const t = relTarget(pc, b1);
      return { mnemonic: "JR", operands: `C, ${hex4(t)}`, length: 2, targetAddr: t };
    }
    case 0x39:
      return { mnemonic: "ADD", operands: "HL, SP", length: 1 };
    case 0x3a:
      return { mnemonic: "LD", operands: "A, (HL-)", length: 1 };
    case 0x3b:
      return { mnemonic: "DEC", operands: "SP", length: 1 };
    case 0x3c:
      return { mnemonic: "INC", operands: "A", length: 1 };
    case 0x3d:
      return { mnemonic: "DEC", operands: "A", length: 1 };
    case 0x3e:
      return { mnemonic: "LD", operands: `A, ${hex2(b1)}`, length: 2 };
    case 0x3f:
      return { mnemonic: "CCF", operands: "", length: 1 };

    // ─── 0xC0-0xFF — mixed control / stack / ALU-imm / LDH ────────
    case 0xc0:
      return { mnemonic: "RET", operands: "NZ", length: 1 };
    case 0xc1:
      return { mnemonic: "POP", operands: "BC", length: 1 };
    case 0xc2: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "JP", operands: `NZ, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xc3: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "JP", operands: hex4(t), length: 3, targetAddr: t };
    }
    case 0xc4: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "CALL", operands: `NZ, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xc5:
      return { mnemonic: "PUSH", operands: "BC", length: 1 };
    case 0xc6:
      return { mnemonic: "ADD", operands: `A, ${hex2(b1)}`, length: 2 };
    case 0xc7:
      return { mnemonic: "RST", operands: "$00", length: 1, targetAddr: 0x00 };
    case 0xc8:
      return { mnemonic: "RET", operands: "Z", length: 1 };
    case 0xc9:
      return { mnemonic: "RET", operands: "", length: 1 };
    case 0xca: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "JP", operands: `Z, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xcc: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "CALL", operands: `Z, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xcd: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "CALL", operands: hex4(t), length: 3, targetAddr: t };
    }
    case 0xce:
      return { mnemonic: "ADC", operands: `A, ${hex2(b1)}`, length: 2 };
    case 0xcf:
      return { mnemonic: "RST", operands: "$08", length: 1, targetAddr: 0x08 };
    case 0xd0:
      return { mnemonic: "RET", operands: "NC", length: 1 };
    case 0xd1:
      return { mnemonic: "POP", operands: "DE", length: 1 };
    case 0xd2: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "JP", operands: `NC, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xd4: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "CALL", operands: `NC, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xd5:
      return { mnemonic: "PUSH", operands: "DE", length: 1 };
    case 0xd6:
      return { mnemonic: "SUB", operands: hex2(b1), length: 2 };
    case 0xd7:
      return { mnemonic: "RST", operands: "$10", length: 1, targetAddr: 0x10 };
    case 0xd8:
      return { mnemonic: "RET", operands: "C", length: 1 };
    case 0xd9:
      return { mnemonic: "RETI", operands: "", length: 1 };
    case 0xda: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "JP", operands: `C, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xdc: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "CALL", operands: `C, ${hex4(t)}`, length: 3, targetAddr: t };
    }
    case 0xde:
      return { mnemonic: "SBC", operands: `A, ${hex2(b1)}`, length: 2 };
    case 0xdf:
      return { mnemonic: "RST", operands: "$18", length: 1, targetAddr: 0x18 };
    case 0xe0: {
      const t = 0xff00 | b1;
      return { mnemonic: "LDH", operands: `(${hex4(t)}), A`, length: 2, targetAddr: t };
    }
    case 0xe1:
      return { mnemonic: "POP", operands: "HL", length: 1 };
    case 0xe2:
      return { mnemonic: "LD", operands: "($FF00+C), A", length: 1 };
    case 0xe5:
      return { mnemonic: "PUSH", operands: "HL", length: 1 };
    case 0xe6:
      return { mnemonic: "AND", operands: hex2(b1), length: 2 };
    case 0xe7:
      return { mnemonic: "RST", operands: "$20", length: 1, targetAddr: 0x20 };
    case 0xe8: {
      const rel = (b1 << 24) >> 24;
      return { mnemonic: "ADD", operands: `SP, ${rel >= 0 ? "+" : ""}${rel}`, length: 2 };
    }
    case 0xe9:
      return { mnemonic: "JP", operands: "HL", length: 1 };
    case 0xea: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "LD", operands: `(${hex4(t)}), A`, length: 3, targetAddr: t };
    }
    case 0xee:
      return { mnemonic: "XOR", operands: hex2(b1), length: 2 };
    case 0xef:
      return { mnemonic: "RST", operands: "$28", length: 1, targetAddr: 0x28 };
    case 0xf0: {
      const t = 0xff00 | b1;
      return { mnemonic: "LDH", operands: `A, (${hex4(t)})`, length: 2, targetAddr: t };
    }
    case 0xf1:
      return { mnemonic: "POP", operands: "AF", length: 1 };
    case 0xf2:
      return { mnemonic: "LD", operands: "A, ($FF00+C)", length: 1 };
    case 0xf3:
      return { mnemonic: "DI", operands: "", length: 1 };
    case 0xf5:
      return { mnemonic: "PUSH", operands: "AF", length: 1 };
    case 0xf6:
      return { mnemonic: "OR", operands: hex2(b1), length: 2 };
    case 0xf7:
      return { mnemonic: "RST", operands: "$30", length: 1, targetAddr: 0x30 };
    case 0xf8: {
      const rel = (b1 << 24) >> 24;
      return { mnemonic: "LD", operands: `HL, SP${rel >= 0 ? "+" : ""}${rel}`, length: 2 };
    }
    case 0xf9:
      return { mnemonic: "LD", operands: "SP, HL", length: 1 };
    case 0xfa: {
      const t = b1 | (b2 << 8);
      return { mnemonic: "LD", operands: `A, (${hex4(t)})`, length: 3, targetAddr: t };
    }
    case 0xfb:
      return { mnemonic: "EI", operands: "", length: 1 };
    case 0xfe:
      return { mnemonic: "CP", operands: hex2(b1), length: 2 };
    case 0xff:
      return { mnemonic: "RST", operands: "$38", length: 1, targetAddr: 0x38 };
  }

  // Unused opcode slots ($D3, $DB, $DD, $E3, $E4, $EB, $EC, $ED, $F4,
  // $FC, $FD) — render as raw bytes so the disassembler never lies
  // about what's there. Length 1 keeps the walker advancing.
  return { mnemonic: "DB", operands: hex2(b0), length: 1 };
}

// ─── CB-prefix opcode decoder ───────────────────────────────────────

function decodeCb(b1: number): DecodedInstruction {
  const reg = REG8[b1 & 0x07]!;
  const group = (b1 >> 6) & 0x03;
  const bitIdx = (b1 >> 3) & 0x07;

  // Groups: 00 = rotate / shift, 01 = BIT, 10 = RES, 11 = SET.
  if (group === 0) {
    const ops = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SWAP", "SRL"] as const;
    return { mnemonic: ops[bitIdx]!, operands: reg, length: 2 };
  }
  const mnemonic = group === 1 ? "BIT" : group === 2 ? "RES" : "SET";
  return { mnemonic, operands: `${bitIdx}, ${reg}`, length: 2 };
}
