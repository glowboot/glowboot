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

/** Wide unsigned add with carry-in, leaving the 32-bit truncated
 *  result plus the C and V flags (as ARM defines them) in the `awc*`
 *  module scalars. Used for every arithmetic data-processing op:
 *  SUB/CMP go through `addWithCarry(a, ~b, 1)`, SBC/RSC use the
 *  actual CPSR.C as the carry-in. Scalar out-params instead of a
 *  result object — this runs once per arithmetic instruction and the
 *  allocation showed up in frame profiles. */
let awcValue = 0;
let awcC = false;
let awcV = false;
function addWithCarry(a: number, b: number, cIn: 0 | 1): void {
  const aU = a >>> 0;
  const bU = b >>> 0;
  const sum = aU + bU + cIn;
  awcValue = sum | 0;
  awcC = sum > 0xffffffff;
  awcV = ((a ^ awcValue) & (b ^ awcValue)) >>> 31 !== 0;
}

/** Shared result instance returned by every `alu()` call — reused to
 *  keep the hot path allocation-free. Callers must consume it before
 *  the next `alu()` call and never retain it. */
const ALU_SCRATCH: AluResult = {
  value: 0,
  writes: true,
  flags: { n: false, z: false, c: false, v: false }
};

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
      addWithCarry(rn, ~op2, 1);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = true;
      break;
    }
    case ALU_RSB: {
      addWithCarry(op2, ~rn, 1);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = true;
      break;
    }
    case ALU_ADD: {
      addWithCarry(rn, op2, 0);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = true;
      break;
    }
    case ALU_ADC: {
      addWithCarry(rn, op2, cBit);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = true;
      break;
    }
    case ALU_SBC: {
      addWithCarry(rn, ~op2, cBit);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = true;
      break;
    }
    case ALU_RSC: {
      addWithCarry(op2, ~rn, cBit);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = true;
      break;
    }
    case ALU_CMP: {
      addWithCarry(rn, ~op2, 1);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = false;
      break;
    }
    case ALU_CMN: {
      addWithCarry(rn, op2, 0);
      value = awcValue;
      c = awcC;
      v = awcV;
      writes = false;
      break;
    }
    default:
      throw new Error(`Unknown ALU op: ${op}`);
  }

  ALU_SCRATCH.value = value;
  ALU_SCRATCH.writes = writes;
  const flags = ALU_SCRATCH.flags;
  flags.n = value < 0;
  flags.z = value === 0;
  flags.c = c;
  flags.v = v;
  return ALU_SCRATCH;
}
