/**
 * ARM7TDMI disassembler — ARM + Thumb. Pure functions, no engine or
 * DOM dependencies, runs anywhere.
 *
 * Coverage: the full ARMv4T instruction set. ARM gets data processing
 * (all 16 ops, immediate + shifted register / register-shifted register
 * operand2), branches (B / BL / BX), single / block data transfer,
 * halfword + signed transfer, multiply (MUL / MLA / UMULL / UMLAL /
 * SMULL / SMLAL), status register (MRS / MSR), single data swap
 * (SWP / SWPB), software interrupt (SWI), all coprocessor encodings
 * (CDP / MCR / MRC / LDC / STC — these trap UND on GBA but assemble
 * legally, so disassembly shows what's there), and the explicit
 * undefined-instruction encoding. Thumb covers Format 1 through 19.
 *
 * Encodings outside ARMv4T (ARMv5's BLX/CLZ/BKPT, ARMv6+ NV-conditional
 * data ops, etc.) fall back to `.word` / `.hword`. The disasm pane
 * treats raw-hex lines the same as decoded ones — they read as
 * `.word 0xE6000000` so the user can still see what's at that address.
 *
 * Output conventions:
 *   - Condition codes are uppercase suffixes (`MOVEQ`, `BLNE`).
 *   - S / B / H / SB / SH / T suffixes are baked into the mnemonic.
 *   - Shift operand: `Rm, LSL #N` / `Rm, LSL Rs`; LSL #0 collapses to
 *     a bare register; LSR #0 / ASR #0 surface as `#32`; RRX named.
 *   - LDM/STM register lists are expanded ({r0, r4-r6, lr}) with
 *     run-coalescing for readability.
 *   - Coprocessor numbers render `p<N>`; coprocessor registers `c<N>`.
 *
 * Output shape mirrors the GB `DecodedInstruction` so the disasm
 * pane can reuse the same row builder.
 */

export interface DecodedGbaInstruction {
  /** Human-readable mnemonic with condition / S / B / H suffixes
   *  already baked in (e.g. `"ADDNES"`, `"LDREQB"`, `"MOV"`). */
  readonly mnemonic: string;
  /** Operand string. Empty for ops with no operands (`NOP` etc.). */
  readonly operands: string;
  /** Bytes consumed — 4 for ARM, 2 for Thumb. */
  readonly length: number;
  /** Absolute 32-bit target for flow-control / PC-relative ops,
   *  undefined for register-only ops. */
  readonly targetAddr?: number;
}

// ─── Shared helpers ───────────────────────────────────────────────────

const REG_NAMES: readonly string[] = [
  "r0",
  "r1",
  "r2",
  "r3",
  "r4",
  "r5",
  "r6",
  "r7",
  "r8",
  "r9",
  "r10",
  "r11",
  "r12",
  "sp",
  "lr",
  "pc"
];
const COND_NAMES: readonly string[] = [
  "EQ",
  "NE",
  "CS",
  "CC",
  "MI",
  "PL",
  "VS",
  "VC",
  "HI",
  "LS",
  "GE",
  "LT",
  "GT",
  "LE",
  "",
  "NV"
];
const DATA_OPS: readonly string[] = [
  "AND",
  "EOR",
  "SUB",
  "RSB",
  "ADD",
  "ADC",
  "SBC",
  "RSC",
  "TST",
  "TEQ",
  "CMP",
  "CMN",
  "ORR",
  "MOV",
  "BIC",
  "MVN"
];
const SHIFT_NAMES: readonly string[] = ["LSL", "LSR", "ASR", "ROR"];

function reg(n: number): string {
  return REG_NAMES[n & 0xf]!;
}

function hex8(n: number): string {
  return "$" + (n >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function hexImm(n: number): string {
  // Show short immediates without leading zero padding to keep the
  // disasm line readable; widen to two digits past 0xFF so 0x100 vs
  // 0x10 stay distinct at a glance.
  const v = n >>> 0;
  const digits = v < 0x100 ? Math.max(1, v.toString(16).length) : Math.max(2, v.toString(16).length);
  return "#$" + v.toString(16).padStart(digits, "0").toUpperCase();
}

function rawWord(opcode: number): DecodedGbaInstruction {
  return {
    mnemonic: ".word",
    operands: hex8(opcode),
    length: 4
  };
}

function rawHalf(opcode: number): DecodedGbaInstruction {
  return {
    mnemonic: ".hword",
    operands: "$" + (opcode & 0xffff).toString(16).padStart(4, "0").toUpperCase(),
    length: 2
  };
}

// ─── ARM ──────────────────────────────────────────────────────────────

/** Decode one ARM-mode 32-bit opcode. `pc` is the address of the
 *  instruction (NOT the pipeline-ahead value). Used for branch-target
 *  resolution (B / BL add (offset<<2) to pc+8). */
export function decodeArm(opcode: number, pc: number): DecodedGbaInstruction {
  opcode >>>= 0;
  const cond = (opcode >>> 28) & 0xf;
  const condStr = COND_NAMES[cond] ?? "";
  // Unconditional NV: most encodings are reserved on ARMv4T. Keep it
  // as raw word so the user sees what's there.
  if (cond === 0xf) return rawWord(opcode);

  // Branch and exchange: 0x012FFF1x
  if ((opcode & 0x0ffffff0) === 0x012fff10) {
    const rn = opcode & 0xf;
    return { mnemonic: "BX" + condStr, operands: reg(rn), length: 4 };
  }

  // Branch / Branch-with-link: bits 27-25 = 101
  if (((opcode >>> 25) & 0x7) === 0x5) {
    const link = (opcode >>> 24) & 1;
    let off = opcode & 0x00ffffff;
    if (off & 0x00800000) off |= 0xff000000; // sign-extend 24-bit
    const target = (pc + 8 + (off << 2)) >>> 0;
    return {
      mnemonic: (link ? "BL" : "B") + condStr,
      operands: hex8(target),
      length: 4,
      targetAddr: target
    };
  }

  // SWI: bits 27-24 = 1111
  if (((opcode >>> 24) & 0xf) === 0xf) {
    const comment = opcode & 0x00ffffff;
    return { mnemonic: "SWI" + condStr, operands: hexImm(comment), length: 4 };
  }

  // Coprocessor data ops + register transfer: bits 27-24 = 1110.
  // GBA's ARM7TDMI has no coprocessor — these trap UND at runtime —
  // but they assemble legally and need to read correctly in disasm.
  // Bit 4 splits CDP (=0) from MCR/MRC (=1); bit 20 splits MCR/MRC.
  if (((opcode >>> 24) & 0xf) === 0xe) {
    const cpNum = (opcode >>> 8) & 0xf;
    const crn = (opcode >>> 16) & 0xf;
    const crd = (opcode >>> 12) & 0xf;
    const crm = opcode & 0xf;
    const op2 = (opcode >>> 5) & 0x7;
    if (((opcode >>> 4) & 1) === 0) {
      // CDP: bits 23-20 = op1 (4 bits)
      const op1 = (opcode >>> 20) & 0xf;
      return {
        mnemonic: "CDP" + condStr,
        operands: `p${cpNum}, ${op1}, c${crd}, c${crn}, c${crm}, ${op2}`,
        length: 4
      };
    }
    // MCR (L=0) / MRC (L=1): bits 23-21 = op1 (3 bits), bit 20 = L,
    // Rd at 15-12 is a *general-purpose* register on the ARM side.
    const l = (opcode >>> 20) & 1;
    const op1 = (opcode >>> 21) & 0x7;
    return {
      mnemonic: (l ? "MRC" : "MCR") + condStr,
      operands: `p${cpNum}, ${op1}, ${reg(crd)}, c${crn}, c${crm}, ${op2}`,
      length: 4
    };
  }

  // Coprocessor load / store: bits 27-25 = 110.
  // Same caveat — UND at runtime on ARM7TDMI but the encoding is real
  // and shows up in object dumps. Format mirrors the ARM ARM:
  // `LDC{cond}{L} p<cp>, c<CRd>, [<Rn>{, #±off}]{!}` etc.
  if (((opcode >>> 25) & 0x7) === 0x6) {
    const p = (opcode >>> 24) & 1;
    const u = (opcode >>> 23) & 1;
    const n = (opcode >>> 22) & 1; // long-transfer flag → `L` suffix
    const w = (opcode >>> 21) & 1;
    const l = (opcode >>> 20) & 1;
    const rn = (opcode >>> 16) & 0xf;
    const crd = (opcode >>> 12) & 0xf;
    const cpNum = (opcode >>> 8) & 0xf;
    const off = (opcode & 0xff) << 2;
    const sign = u ? "" : "-";
    const offStr = `#${sign}$${off.toString(16).toUpperCase()}`;
    const addr = p ? `[${reg(rn)}, ${offStr}]${w ? "!" : ""}` : `[${reg(rn)}], ${offStr}`;
    return {
      mnemonic: (l ? "LDC" : "STC") + condStr + (n ? "L" : ""),
      operands: `p${cpNum}, c${crd}, ${addr}`,
      length: 4
    };
  }

  // MUL / MLA / UMULL / UMLAL / SMULL / SMLAL: bits 27-22 = 000000, bits 7-4 = 1001
  if ((opcode & 0x0fc000f0) === 0x00000090) {
    const a = (opcode >>> 21) & 1;
    const s = (opcode >>> 20) & 1;
    const rd = (opcode >>> 16) & 0xf;
    const rn = (opcode >>> 12) & 0xf;
    const rs = (opcode >>> 8) & 0xf;
    const rm = opcode & 0xf;
    const mn = (a ? "MLA" : "MUL") + condStr + (s ? "S" : "");
    return {
      mnemonic: mn,
      operands: a ? `${reg(rd)}, ${reg(rm)}, ${reg(rs)}, ${reg(rn)}` : `${reg(rd)}, ${reg(rm)}, ${reg(rs)}`,
      length: 4
    };
  }
  if ((opcode & 0x0f8000f0) === 0x00800090) {
    // Long multiply
    const s = (opcode >>> 20) & 1;
    const a = (opcode >>> 21) & 1;
    const u = (opcode >>> 22) & 1; // 0=unsigned, 1=signed
    const rdHi = (opcode >>> 16) & 0xf;
    const rdLo = (opcode >>> 12) & 0xf;
    const rs = (opcode >>> 8) & 0xf;
    const rm = opcode & 0xf;
    const base = (u ? "S" : "U") + (a ? "MLAL" : "MULL");
    return {
      mnemonic: base + condStr + (s ? "S" : ""),
      operands: `${reg(rdLo)}, ${reg(rdHi)}, ${reg(rm)}, ${reg(rs)}`,
      length: 4
    };
  }

  // MRS / MSR (status register): bits 27-23 = 00010, bits 21-20 = 0
  if ((opcode & 0x0fbf0fff) === 0x010f0000) {
    const r = (opcode >>> 22) & 1;
    const rd = (opcode >>> 12) & 0xf;
    return {
      mnemonic: "MRS" + condStr,
      operands: `${reg(rd)}, ${r ? "SPSR" : "CPSR"}`,
      length: 4
    };
  }
  if ((opcode & 0x0db0f000) === 0x0120f000) {
    // MSR (immediate or register)
    const r = (opcode >>> 22) & 1;
    const fieldMask = (opcode >>> 16) & 0xf;
    const flagSuffix = `_${fieldMask & 8 ? "f" : ""}${fieldMask & 4 ? "s" : ""}${fieldMask & 2 ? "x" : ""}${fieldMask & 1 ? "c" : ""}`;
    const psr = (r ? "SPSR" : "CPSR") + flagSuffix;
    if (opcode & 0x02000000) {
      // Immediate form
      const imm = opcode & 0xff;
      const rot = ((opcode >>> 8) & 0xf) * 2;
      const value = rotateRight(imm, rot);
      return { mnemonic: "MSR" + condStr, operands: `${psr}, ${hexImm(value)}`, length: 4 };
    }
    const rm = opcode & 0xf;
    return { mnemonic: "MSR" + condStr, operands: `${psr}, ${reg(rm)}`, length: 4 };
  }

  // SWP / SWPB: bits 27-23 = 00010, bit 24 = 1, bits 7-4 = 1001
  if ((opcode & 0x0fb00ff0) === 0x01000090) {
    const b = (opcode >>> 22) & 1;
    const rn = (opcode >>> 16) & 0xf;
    const rd = (opcode >>> 12) & 0xf;
    const rm = opcode & 0xf;
    return {
      mnemonic: "SWP" + condStr + (b ? "B" : ""),
      operands: `${reg(rd)}, ${reg(rm)}, [${reg(rn)}]`,
      length: 4
    };
  }

  // Halfword and signed-byte data transfer (LDRH / STRH / LDRSB / LDRSH)
  if ((opcode & 0x0e000090) === 0x00000090 && ((opcode >>> 4) & 0xf) !== 0x9) {
    const p = (opcode >>> 24) & 1;
    const u = (opcode >>> 23) & 1;
    const i = (opcode >>> 22) & 1; // 0 = register offset, 1 = immediate offset
    const w = (opcode >>> 21) & 1;
    const l = (opcode >>> 20) & 1;
    const rn = (opcode >>> 16) & 0xf;
    const rd = (opcode >>> 12) & 0xf;
    const sh = (opcode >>> 5) & 0x3;
    let suffix: string;
    if (l === 0) suffix = "H";
    else if (sh === 1) suffix = "H";
    else if (sh === 2) suffix = "SB";
    else if (sh === 3) suffix = "SH";
    else suffix = "?";
    const mn = (l ? "LDR" : "STR") + condStr + suffix;
    const sign = u ? "" : "-";
    const offStr = i
      ? `#${sign}$${(((opcode >>> 8) & 0xf0) | (opcode & 0xf)).toString(16).toUpperCase()}`
      : `${sign}${reg(opcode & 0xf)}`;
    const addr = p ? `[${reg(rn)}, ${offStr}]${w ? "!" : ""}` : `[${reg(rn)}], ${offStr}`;
    return { mnemonic: mn, operands: `${reg(rd)}, ${addr}`, length: 4 };
  }

  // Block data transfer: bits 27-25 = 100
  if (((opcode >>> 25) & 0x7) === 0x4) {
    const p = (opcode >>> 24) & 1;
    const u = (opcode >>> 23) & 1;
    const s = (opcode >>> 22) & 1;
    const w = (opcode >>> 21) & 1;
    const l = (opcode >>> 20) & 1;
    const rn = (opcode >>> 16) & 0xf;
    const mode = l ? (u ? (p ? "IB" : "IA") : p ? "DB" : "DA") : u ? (p ? "IB" : "IA") : p ? "DB" : "DA";
    // The full LDM/STM addressing-mode naming has historical PUSH/POP/LDMFD
    // aliases; we use the canonical IA/IB/DA/DB suffix so callers see
    // exactly what the encoding requested.
    const list = regListString(opcode & 0xffff);
    return {
      mnemonic: (l ? "LDM" : "STM") + condStr + mode,
      operands: `${reg(rn)}${w ? "!" : ""}, ${list}${s ? "^" : ""}`,
      length: 4
    };
  }

  // Single data transfer: bits 27-26 = 01
  if (((opcode >>> 26) & 0x3) === 0x1) {
    const i = (opcode >>> 25) & 1; // 0 = imm offset, 1 = register offset
    // Undefined-instruction trap encoding: the register-offset form
    // (I=1) reserves bit 4 = 0 for the shift type / amount. Bit 4 = 1
    // in that slot is the explicit UNDEF encoding (ARMv4T §A3.21).
    // Real CPUs raise the Undefined exception here; the disassembler
    // surfaces it visibly so the user can tell "intentional trap"
    // apart from "data that happens to look like a store".
    if (i === 1 && ((opcode >>> 4) & 1) === 1) {
      return { mnemonic: "UND" + condStr, operands: hex8(opcode), length: 4 };
    }
    const p = (opcode >>> 24) & 1;
    const u = (opcode >>> 23) & 1;
    const b = (opcode >>> 22) & 1;
    const w = (opcode >>> 21) & 1;
    const l = (opcode >>> 20) & 1;
    const rn = (opcode >>> 16) & 0xf;
    const rd = (opcode >>> 12) & 0xf;
    const mn = (l ? "LDR" : "STR") + condStr + (b ? "B" : "") + (!p && w ? "T" : "");
    let offStr: string;
    if (i === 0) {
      const off = opcode & 0xfff;
      offStr = `#${u ? "" : "-"}$${off.toString(16).toUpperCase()}`;
    } else {
      const rm = opcode & 0xf;
      const shAmt = (opcode >>> 7) & 0x1f;
      const shType = (opcode >>> 5) & 0x3;
      offStr = `${u ? "" : "-"}${reg(rm)}`;
      if (shAmt !== 0 || shType !== 0) {
        offStr += `, ${SHIFT_NAMES[shType]} #${shAmt}`;
      }
    }
    const addr = p ? `[${reg(rn)}, ${offStr}]${w ? "!" : ""}` : `[${reg(rn)}], ${offStr}`;
    return { mnemonic: mn, operands: `${reg(rd)}, ${addr}`, length: 4 };
  }

  // Data processing: bits 27-26 = 00
  if (((opcode >>> 26) & 0x3) === 0x0) {
    const i = (opcode >>> 25) & 1;
    const op = (opcode >>> 21) & 0xf;
    const s = (opcode >>> 20) & 1;
    const rn = (opcode >>> 16) & 0xf;
    const rd = (opcode >>> 12) & 0xf;
    const isCompareLike = op >= 8 && op <= 11; // TST, TEQ, CMP, CMN — never set Rd
    const isMov = op === 13 || op === 15; // MOV, MVN — single source
    const base = DATA_OPS[op]!;
    // S is implicit on TST/TEQ/CMP/CMN; only mark it on the others.
    const mn = base + condStr + (s && !isCompareLike ? "S" : "");
    let operand2: string;
    if (i) {
      const imm = opcode & 0xff;
      const rot = ((opcode >>> 8) & 0xf) * 2;
      operand2 = hexImm(rotateRight(imm, rot));
    } else {
      operand2 = formatShiftedReg(opcode);
    }
    let operands: string;
    if (isMov) operands = `${reg(rd)}, ${operand2}`;
    else if (isCompareLike) operands = `${reg(rn)}, ${operand2}`;
    else operands = `${reg(rd)}, ${reg(rn)}, ${operand2}`;
    return { mnemonic: mn, operands, length: 4 };
  }

  return rawWord(opcode);
}

function rotateRight(value: number, amount: number): number {
  amount &= 31;
  if (amount === 0) return value >>> 0;
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

function formatShiftedReg(opcode: number): string {
  const rm = opcode & 0xf;
  const shType = (opcode >>> 5) & 0x3;
  const regShift = (opcode >>> 4) & 1;
  if (regShift) {
    const rs = (opcode >>> 8) & 0xf;
    return `${reg(rm)}, ${SHIFT_NAMES[shType]} ${reg(rs)}`;
  }
  const shAmt = (opcode >>> 7) & 0x1f;
  if (shAmt === 0 && shType === 0) return reg(rm);
  // LSR #0 / ASR #0 are encoded as #32; surface that distinction.
  if (shAmt === 0 && (shType === 1 || shType === 2)) return `${reg(rm)}, ${SHIFT_NAMES[shType]} #32`;
  if (shAmt === 0 && shType === 3) return `${reg(rm)}, RRX`;
  return `${reg(rm)}, ${SHIFT_NAMES[shType]} #${shAmt}`;
}

/** Compact register-list rendering for LDM/STM. */
function regListString(mask: number): string {
  const parts: string[] = [];
  let run = -1;
  for (let i = 0; i <= 16; i++) {
    const set = i < 16 && (mask & (1 << i)) !== 0;
    if (set && run < 0) run = i;
    else if (!set && run >= 0) {
      const end = i - 1;
      parts.push(run === end ? reg(run) : end === run + 1 ? `${reg(run)}, ${reg(end)}` : `${reg(run)}-${reg(end)}`);
      run = -1;
    }
  }
  return "{" + parts.join(", ") + "}";
}

// ─── Thumb ────────────────────────────────────────────────────────────

/** Decode one Thumb-mode 16-bit opcode. `pc` is the instruction's
 *  address; needed for PC-relative loads and branch targets. */
export function decodeThumb(opcode: number, pc: number): DecodedGbaInstruction {
  opcode &= 0xffff;

  // Format 1 — Move shifted register: 000 op imm rs rd (op ≠ 11)
  if ((opcode & 0xe000) === 0x0000 && ((opcode >>> 11) & 0x3) !== 0x3) {
    const op = (opcode >>> 11) & 0x3;
    const offset = (opcode >>> 6) & 0x1f;
    const rs = (opcode >>> 3) & 0x7;
    const rd = opcode & 0x7;
    const mn = ["LSL", "LSR", "ASR"][op]!;
    return { mnemonic: mn, operands: `${reg(rd)}, ${reg(rs)}, #${offset}`, length: 2 };
  }

  // Format 2 — Add/subtract: 00011 I op rn|imm rs rd
  if ((opcode & 0xf800) === 0x1800) {
    const i = (opcode >>> 10) & 1;
    const op = (opcode >>> 9) & 1;
    const rnOrImm = (opcode >>> 6) & 0x7;
    const rs = (opcode >>> 3) & 0x7;
    const rd = opcode & 0x7;
    const mn = op ? "SUB" : "ADD";
    const src2 = i ? `#${rnOrImm}` : reg(rnOrImm);
    return { mnemonic: mn, operands: `${reg(rd)}, ${reg(rs)}, ${src2}`, length: 2 };
  }

  // Format 3 — Move/compare/add/subtract immediate: 001 op rd imm8
  if ((opcode & 0xe000) === 0x2000) {
    const op = (opcode >>> 11) & 0x3;
    const rd = (opcode >>> 8) & 0x7;
    const imm = opcode & 0xff;
    const mn = ["MOV", "CMP", "ADD", "SUB"][op]!;
    return { mnemonic: mn, operands: `${reg(rd)}, #$${imm.toString(16).toUpperCase()}`, length: 2 };
  }

  // Format 4 — ALU operations: 010000 op rs rd
  if ((opcode & 0xfc00) === 0x4000) {
    const op = (opcode >>> 6) & 0xf;
    const rs = (opcode >>> 3) & 0x7;
    const rd = opcode & 0x7;
    const ops = [
      "AND",
      "EOR",
      "LSL",
      "LSR",
      "ASR",
      "ADC",
      "SBC",
      "ROR",
      "TST",
      "NEG",
      "CMP",
      "CMN",
      "ORR",
      "MUL",
      "BIC",
      "MVN"
    ];
    return { mnemonic: ops[op]!, operands: `${reg(rd)}, ${reg(rs)}`, length: 2 };
  }

  // Format 5 — Hi-register ops / BX: 010001 op H1 H2 rs rd
  if ((opcode & 0xfc00) === 0x4400) {
    const op = (opcode >>> 8) & 0x3;
    const h1 = (opcode >>> 7) & 1;
    const h2 = (opcode >>> 6) & 1;
    const rs = ((opcode >>> 3) & 0x7) + (h2 ? 8 : 0);
    const rd = (opcode & 0x7) + (h1 ? 8 : 0);
    if (op === 3) {
      return { mnemonic: "BX", operands: reg(rs), length: 2 };
    }
    const mn = ["ADD", "CMP", "MOV"][op]!;
    return { mnemonic: mn, operands: `${reg(rd)}, ${reg(rs)}`, length: 2 };
  }

  // Format 6 — PC-relative load: 01001 rd imm8 (target = (pc+4) & ~3 + imm8*4)
  if ((opcode & 0xf800) === 0x4800) {
    const rd = (opcode >>> 8) & 0x7;
    const imm = opcode & 0xff;
    const target = (((pc + 4) & ~3) + imm * 4) >>> 0;
    return {
      mnemonic: "LDR",
      operands: `${reg(rd)}, [pc, #$${(imm * 4).toString(16).toUpperCase()}]  ; ${hex8(target)}`,
      length: 2,
      targetAddr: target
    };
  }

  // Format 7 — Load/store with register offset: 0101 LB 0 ro rb rd
  if ((opcode & 0xf200) === 0x5000) {
    const l = (opcode >>> 11) & 1;
    const b = (opcode >>> 10) & 1;
    const ro = (opcode >>> 6) & 0x7;
    const rb = (opcode >>> 3) & 0x7;
    const rd = opcode & 0x7;
    const mn = (l ? "LDR" : "STR") + (b ? "B" : "");
    return { mnemonic: mn, operands: `${reg(rd)}, [${reg(rb)}, ${reg(ro)}]`, length: 2 };
  }

  // Format 8 — Load/store sign-extended byte/halfword: 0101 HS 1 ro rb rd
  if ((opcode & 0xf200) === 0x5200) {
    const h = (opcode >>> 11) & 1;
    const s = (opcode >>> 10) & 1;
    const ro = (opcode >>> 6) & 0x7;
    const rb = (opcode >>> 3) & 0x7;
    const rd = opcode & 0x7;
    let mn: string;
    if (s === 0 && h === 0) mn = "STRH";
    else if (s === 0 && h === 1) mn = "LDRH";
    else if (s === 1 && h === 0) mn = "LDRSB";
    else mn = "LDRSH";
    return { mnemonic: mn, operands: `${reg(rd)}, [${reg(rb)}, ${reg(ro)}]`, length: 2 };
  }

  // Format 9 — Load/store with imm offset: 011 BL imm5 rb rd
  if ((opcode & 0xe000) === 0x6000) {
    const b = (opcode >>> 12) & 1;
    const l = (opcode >>> 11) & 1;
    const imm5 = (opcode >>> 6) & 0x1f;
    const rb = (opcode >>> 3) & 0x7;
    const rd = opcode & 0x7;
    const scale = b ? 1 : 4;
    const mn = (l ? "LDR" : "STR") + (b ? "B" : "");
    return {
      mnemonic: mn,
      operands: `${reg(rd)}, [${reg(rb)}, #$${(imm5 * scale).toString(16).toUpperCase()}]`,
      length: 2
    };
  }

  // Format 10 — Load/store halfword: 1000 L imm5 rb rd
  if ((opcode & 0xf000) === 0x8000) {
    const l = (opcode >>> 11) & 1;
    const imm5 = (opcode >>> 6) & 0x1f;
    const rb = (opcode >>> 3) & 0x7;
    const rd = opcode & 0x7;
    return {
      mnemonic: l ? "LDRH" : "STRH",
      operands: `${reg(rd)}, [${reg(rb)}, #$${(imm5 * 2).toString(16).toUpperCase()}]`,
      length: 2
    };
  }

  // Format 11 — SP-relative load/store: 1001 L rd imm8
  if ((opcode & 0xf000) === 0x9000) {
    const l = (opcode >>> 11) & 1;
    const rd = (opcode >>> 8) & 0x7;
    const imm = opcode & 0xff;
    return {
      mnemonic: l ? "LDR" : "STR",
      operands: `${reg(rd)}, [sp, #$${(imm * 4).toString(16).toUpperCase()}]`,
      length: 2
    };
  }

  // Format 12 — Load address: 1010 SP rd imm8 (rd = pc/sp + imm8*4)
  if ((opcode & 0xf000) === 0xa000) {
    const sp = (opcode >>> 11) & 1;
    const rd = (opcode >>> 8) & 0x7;
    const imm = opcode & 0xff;
    return {
      mnemonic: "ADD",
      operands: `${reg(rd)}, ${sp ? "sp" : "pc"}, #$${(imm * 4).toString(16).toUpperCase()}`,
      length: 2
    };
  }

  // Format 13 — Add offset to SP: 10110000 S imm7
  if ((opcode & 0xff00) === 0xb000) {
    const s = (opcode >>> 7) & 1;
    const imm = (opcode & 0x7f) * 4;
    return {
      mnemonic: s ? "SUB" : "ADD",
      operands: `sp, #$${imm.toString(16).toUpperCase()}`,
      length: 2
    };
  }

  // Format 14 — Push/pop registers: 1011 L 10 R rlist
  if ((opcode & 0xf600) === 0xb400) {
    const l = (opcode >>> 11) & 1;
    const r = (opcode >>> 8) & 1;
    let mask = opcode & 0xff;
    // R bit adds lr (push) or pc (pop) to the list at bit 14 / 15
    if (r) mask |= l ? 1 << 15 : 1 << 14;
    return { mnemonic: l ? "POP" : "PUSH", operands: regListString(mask), length: 2 };
  }

  // Format 15 — Multiple load/store: 1100 L rb rlist
  if ((opcode & 0xf000) === 0xc000) {
    const l = (opcode >>> 11) & 1;
    const rb = (opcode >>> 8) & 0x7;
    const mask = opcode & 0xff;
    return {
      mnemonic: l ? "LDMIA" : "STMIA",
      operands: `${reg(rb)}!, ${regListString(mask)}`,
      length: 2
    };
  }

  // Format 17 — SWI: 11011111 imm8
  if ((opcode & 0xff00) === 0xdf00) {
    const imm = opcode & 0xff;
    return { mnemonic: "SWI", operands: `#$${imm.toString(16).toUpperCase()}`, length: 2 };
  }

  // Format 16 — Conditional branch: 1101 cond simm8
  if ((opcode & 0xf000) === 0xd000) {
    const cond = (opcode >>> 8) & 0xf;
    // cond=0xE (AL) is undefined for Format 16 — assemblers emit
    // Format 18 (unconditional B) instead. cond=0xF is the SWI
    // encoding already handled above. Reject both so neither slips
    // through as a malformed branch.
    if (cond === 0xe || cond === 0xf) {
      return rawHalf(opcode);
    }
    let off = opcode & 0xff;
    if (off & 0x80) off |= 0xffffff00;
    const target = (pc + 4 + (off << 1)) >>> 0;
    return {
      mnemonic: "B" + (COND_NAMES[cond] ?? ""),
      operands: hex8(target),
      length: 2,
      targetAddr: target
    };
  }

  // Format 18 — Unconditional branch: 11100 simm11
  if ((opcode & 0xf800) === 0xe000) {
    let off = opcode & 0x7ff;
    if (off & 0x400) off |= 0xfffff800;
    const target = (pc + 4 + (off << 1)) >>> 0;
    return { mnemonic: "B", operands: hex8(target), length: 2, targetAddr: target };
  }

  // Format 19 — Long branch with link, FIRST half: 11110 simm11 (high)
  // Encodes the upper 11 bits of a 22-bit offset; the second half
  // (11111 imm11) completes it. Disasm shows just the half — the
  // pane that wants the full target should peek at the next halfword
  // and call `combineThumbBl()`.
  if ((opcode & 0xf800) === 0xf000) {
    let off = opcode & 0x7ff;
    if (off & 0x400) off |= 0xfffff800;
    const halfTarget = (pc + 4 + (off << 12)) >>> 0;
    return { mnemonic: "BL", operands: `(hi) ${hex8(halfTarget)}`, length: 2, targetAddr: halfTarget };
  }
  if ((opcode & 0xf800) === 0xf800) {
    const off = opcode & 0x7ff;
    return { mnemonic: "BL", operands: `(lo) +${(off << 1).toString(16).toUpperCase()}`, length: 2 };
  }

  return rawHalf(opcode);
}

/** Combine the two halves of a Thumb BL pair into the absolute call
 *  target. `pcHi` is the address of the first half. */
export function combineThumbBl(hi: number, lo: number, pcHi: number): number {
  let offHi = hi & 0x7ff;
  if (offHi & 0x400) offHi |= 0xfffff800;
  const offLo = lo & 0x7ff;
  return (pcHi + 4 + (offHi << 12) + (offLo << 1)) >>> 0;
}
