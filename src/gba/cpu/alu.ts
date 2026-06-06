/**
 * ARM7TDMI data-processing ALU.
 *
 * Every data-processing instruction routes through `alu()`. The 16
 * opcodes split into two families:
 *
 *   • Logical (AND/EOR/TST/TEQ/ORR/MOV/BIC/MVN): C comes from the
 *     barrel shifter's carry-out; V is preserved (the previous CPSR.V
 *     is passed through).
 *   • Arithmetic (SUB/RSB/ADD/ADC/SBC/RSC/CMP/CMN): C and V are
 *     computed from the operation itself. Subtraction in ARM treats
 *     C as "no borrow": SUB sets C when there was no borrow,
 *     equivalent to evaluating `a + ~b + 1` as a wide unsigned add
 *     and looking at the carry-out.
 *
 * TST/TEQ/CMP/CMN compute exactly like AND/EOR/SUB/ADD respectively
 * but discard the result — caller decides whether to write back.
 */

export type AluOp = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export const ALU_AND: AluOp = 0;
export const ALU_EOR: AluOp = 1;
export const ALU_SUB: AluOp = 2;
export const ALU_RSB: AluOp = 3;
export const ALU_ADD: AluOp = 4;
export const ALU_ADC: AluOp = 5;
export const ALU_SBC: AluOp = 6;
export const ALU_RSC: AluOp = 7;
export const ALU_TST: AluOp = 8;
export const ALU_TEQ: AluOp = 9;
export const ALU_CMP: AluOp = 10;
export const ALU_CMN: AluOp = 11;
export const ALU_ORR: AluOp = 12;
export const ALU_MOV: AluOp = 13;
export const ALU_BIC: AluOp = 14;
export const ALU_MVN: AluOp = 15;

interface AluFlags {
  n: boolean;
  z: boolean;
  c: boolean;
  v: boolean;
}

export interface AluResult {
  value: number;
  /** Whether this op writes its `value` back to Rd. False for the
   *  compare-only ops (TST/TEQ/CMP/CMN). */
  writes: boolean;
  flags: AluFlags;
}

/** Wide unsigned add with carry-in, returning the 32-bit truncated
 *  result plus the C and V flags as ARM defines them. Used for every
 *  arithmetic data-processing op: SUB/CMP go through `addWithCarry(a, ~b, 1)`,
 *  SBC/RSC use the actual CPSR.C as the carry-in. */
function addWithCarry(a: number, b: number, cIn: 0 | 1): { value: number; c: boolean; v: boolean } {
  const aU = a >>> 0;
  const bU = b >>> 0;
  const sum = aU + bU + cIn;
  const value = sum | 0;
  const c = sum > 0xffffffff;
  const v = ((a ^ value) & (b ^ value)) >>> 31 !== 0;
  return { value, c, v };
}

export function alu(op: AluOp, rn: number, op2: number, cIn: boolean, vIn: boolean, shifterC: boolean): AluResult {
  rn = rn | 0;
  op2 = op2 | 0;
  const cBit: 0 | 1 = cIn ? 1 : 0;

  let value: number;
  let c: boolean;
  let v: boolean;
  let writes: boolean;

  switch (op) {
    case ALU_AND:
      value = rn & op2;
      c = shifterC;
      v = vIn;
      writes = true;
      break;
    case ALU_EOR:
      value = rn ^ op2;
      c = shifterC;
      v = vIn;
      writes = true;
      break;
    case ALU_ORR:
      value = rn | op2;
      c = shifterC;
      v = vIn;
      writes = true;
      break;
    case ALU_BIC:
      value = rn & ~op2;
      c = shifterC;
      v = vIn;
      writes = true;
      break;
    case ALU_MOV:
      value = op2;
      c = shifterC;
      v = vIn;
      writes = true;
      break;
    case ALU_MVN:
      value = ~op2 | 0;
      c = shifterC;
      v = vIn;
      writes = true;
      break;
    case ALU_TST:
      value = rn & op2;
      c = shifterC;
      v = vIn;
      writes = false;
      break;
    case ALU_TEQ:
      value = rn ^ op2;
      c = shifterC;
      v = vIn;
      writes = false;
      break;
    case ALU_SUB: {
      const r = addWithCarry(rn, ~op2, 1);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = true;
      break;
    }
    case ALU_RSB: {
      const r = addWithCarry(op2, ~rn, 1);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = true;
      break;
    }
    case ALU_ADD: {
      const r = addWithCarry(rn, op2, 0);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = true;
      break;
    }
    case ALU_ADC: {
      const r = addWithCarry(rn, op2, cBit);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = true;
      break;
    }
    case ALU_SBC: {
      const r = addWithCarry(rn, ~op2, cBit);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = true;
      break;
    }
    case ALU_RSC: {
      const r = addWithCarry(op2, ~rn, cBit);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = true;
      break;
    }
    case ALU_CMP: {
      const r = addWithCarry(rn, ~op2, 1);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = false;
      break;
    }
    case ALU_CMN: {
      const r = addWithCarry(rn, op2, 0);
      value = r.value;
      c = r.c;
      v = r.v;
      writes = false;
      break;
    }
    default:
      throw new Error(`Unknown ALU op: ${op}`);
  }

  return {
    value,
    writes,
    flags: { n: value < 0, z: value === 0, c, v }
  };
}
