/**
 * ARM condition codes — the top 4 bits of every ARM-mode instruction.
 *
 * `NV` (1111) is documented as "reserved" on ARM7TDMI: the documented
 * behaviour is "never execute", so we treat it as always-false. Some
 * later ARM cores reuse this slot for unconditional instructions
 * (BLX immediate, PLD, …); on ARM7 those encodings simply skip.
 */

import { CPSR_C, CPSR_N, CPSR_V, CPSR_Z } from "./registers.js";

export const COND_EQ = 0x0;
export const COND_NE = 0x1;
export const COND_CS = 0x2;
export const COND_CC = 0x3;
export const COND_MI = 0x4;
export const COND_PL = 0x5;
export const COND_VS = 0x6;
export const COND_VC = 0x7;
export const COND_HI = 0x8;
export const COND_LS = 0x9;
export const COND_GE = 0xa;
export const COND_LT = 0xb;
export const COND_GT = 0xc;
export const COND_LE = 0xd;
export const COND_AL = 0xe;
export const COND_NV = 0xf;

export function checkCondition(cond: number, cpsr: number): boolean {
  const n = (cpsr & CPSR_N) !== 0;
  const z = (cpsr & CPSR_Z) !== 0;
  const c = (cpsr & CPSR_C) !== 0;
  const v = (cpsr & CPSR_V) !== 0;
  switch (cond & 0xf) {
    case COND_EQ:
      return z;
    case COND_NE:
      return !z;
    case COND_CS:
      return c;
    case COND_CC:
      return !c;
    case COND_MI:
      return n;
    case COND_PL:
      return !n;
    case COND_VS:
      return v;
    case COND_VC:
      return !v;
    case COND_HI:
      return c && !z;
    case COND_LS:
      return !c || z;
    case COND_GE:
      return n === v;
    case COND_LT:
      return n !== v;
    case COND_GT:
      return !z && n === v;
    case COND_LE:
      return z || n !== v;
    case COND_AL:
      return true;
    case COND_NV:
      return false;
    default:
      throw new Error(`Unreachable: cond ${cond}`);
  }
}
