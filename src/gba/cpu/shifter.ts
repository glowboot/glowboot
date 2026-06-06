/**
 * ARM7TDMI barrel shifter.
 *
 * Used by data-processing instructions (op2 = Rm shifted) and by single-
 * data-transfer / halfword-transfer offsets that use the register-shifted
 * form. LDM/STM and MUL/MLA bypass the shifter. Returns both the shifted
 * value AND the shifter carry-out (which feeds the C flag in logical ALU
 * ops and is otherwise discarded).
 *
 * The semantics differ between shift-by-immediate and shift-by-register
 * forms. Two key gotchas the JavaScript bitwise operators do NOT do for
 * us:
 *   • LSR/ASR/ROR by an encoded immediate of zero are special-cased to
 *     mean LSR #32 / ASR #32 / RRX, respectively. LSL #0 is a literal
 *     no-op that preserves the input carry.
 *   • Shift-by-register takes the low 8 bits of Rs and must produce
 *     well-defined results for ≥ 32 — JS `<<` / `>>>` truncate the
 *     shift amount mod 32, which is the wrong behaviour for this ISA.
 */

export type ShiftType = 0 | 1 | 2 | 3;

export const SHIFT_LSL: ShiftType = 0;
export const SHIFT_LSR: ShiftType = 1;
export const SHIFT_ASR: ShiftType = 2;
export const SHIFT_ROR: ShiftType = 3;

export interface ShiftResult {
  /** 32-bit result (sign-bit-correct number, callable through `| 0`). */
  value: number;
  /** Shifter carry-out — caller decides whether to commit to CPSR.C. */
  carryOut: boolean;
}

const NO_OP_PRESERVE_CARRY = (operand: number, cIn: boolean): ShiftResult => ({ value: operand | 0, carryOut: cIn });

/** Immediate-form barrel shift. `amount` is the encoded shift amount
 *  (0–31). The special values LSR #0 / ASR #0 / ROR #0 are decoded
 *  here as LSR #32 / ASR #32 / RRX. */
export function shiftByImmediate(operand: number, type: ShiftType, amount: number, cIn: boolean): ShiftResult {
  operand = operand | 0;
  switch (type) {
    case SHIFT_LSL: {
      if (amount === 0) return NO_OP_PRESERVE_CARRY(operand, cIn);
      return {
        value: (operand << amount) | 0,
        carryOut: ((operand >>> (32 - amount)) & 1) !== 0
      };
    }
    case SHIFT_LSR: {
      const actual = amount === 0 ? 32 : amount;
      if (actual === 32) return { value: 0, carryOut: operand >>> 31 !== 0 };
      return {
        value: (operand >>> actual) | 0,
        carryOut: ((operand >>> (actual - 1)) & 1) !== 0
      };
    }
    case SHIFT_ASR: {
      const actual = amount === 0 ? 32 : amount;
      if (actual >= 32) {
        const sign = operand >> 31;
        return { value: sign, carryOut: operand >>> 31 !== 0 };
      }
      return {
        value: (operand >> actual) | 0,
        carryOut: ((operand >>> (actual - 1)) & 1) !== 0
      };
    }
    case SHIFT_ROR: {
      if (amount === 0) {
        // RRX — rotate right with extend, feeding old carry into bit 31.
        return {
          value: ((cIn ? 1 : 0) << 31) | (operand >>> 1) | 0,
          carryOut: (operand & 1) !== 0
        };
      }
      return {
        value: (operand >>> amount) | (operand << (32 - amount)) | 0,
        carryOut: ((operand >>> (amount - 1)) & 1) !== 0
      };
    }
    default:
      throw new Error(`Unknown shift type: ${type}`);
  }
}

/** Register-form barrel shift. `amount` is the low 8 bits of Rs.
 *  Differs from the immediate form: amount === 0 is "no shift"
 *  (carry preserved), and shifts ≥ 32 are well-defined per the
 *  ARM7TDMI spec rather than mod-32 truncated. */
export function shiftByRegister(operand: number, type: ShiftType, amount: number, cIn: boolean): ShiftResult {
  operand = operand | 0;
  amount = amount & 0xff;
  if (amount === 0) return NO_OP_PRESERVE_CARRY(operand, cIn);
  switch (type) {
    case SHIFT_LSL: {
      if (amount < 32) {
        return {
          value: (operand << amount) | 0,
          carryOut: ((operand >>> (32 - amount)) & 1) !== 0
        };
      }
      if (amount === 32) return { value: 0, carryOut: (operand & 1) !== 0 };
      return { value: 0, carryOut: false };
    }
    case SHIFT_LSR: {
      if (amount < 32) {
        return {
          value: (operand >>> amount) | 0,
          carryOut: ((operand >>> (amount - 1)) & 1) !== 0
        };
      }
      if (amount === 32) return { value: 0, carryOut: operand >>> 31 !== 0 };
      return { value: 0, carryOut: false };
    }
    case SHIFT_ASR: {
      if (amount < 32) {
        return {
          value: (operand >> amount) | 0,
          carryOut: ((operand >>> (amount - 1)) & 1) !== 0
        };
      }
      const sign = operand >> 31;
      return { value: sign, carryOut: operand >>> 31 !== 0 };
    }
    case SHIFT_ROR: {
      const lowFive = amount & 0x1f;
      if (lowFive === 0) {
        // Rs[7:0] non-zero but Rs[4:0] zero — operand unchanged,
        // carry comes from bit 31.
        return { value: operand, carryOut: operand >>> 31 !== 0 };
      }
      return {
        value: (operand >>> lowFive) | (operand << (32 - lowFive)) | 0,
        carryOut: ((operand >>> (lowFive - 1)) & 1) !== 0
      };
    }
    default:
      throw new Error(`Unknown shift type: ${type}`);
  }
}
