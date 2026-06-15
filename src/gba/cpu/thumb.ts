/**
 * Thumb-state instruction dispatch + per-format executors.
 *
 * Thumb is a 16-bit subset of ARM. Each instruction maps to one or
 * two ARM-equivalent operations on a restricted register file (R0–R7
 * for most formats; R8–R15 accessible only through specific "hi
 * register" instructions). All Thumb data-processing ops implicitly
 * set CPSR flags — there is no per-instruction S bit and no per-
 * instruction condition code (only branches are conditional).
 *
 * Pipeline emulation mirrors ARM but at half-width: R15 reads as
 * `instruction_addr + 4` because the prefetch is two halfwords ahead.
 * `stepThumb` advances r[15] by 2 before dispatch, so during
 * execution `regs.r[15]` is `original_PC + 2` and reads-as-PC+4 means
 * adding 2 to `regs.r[15]`.
 *
 * Coverage: all 19 Thumb instruction formats. Per-format executors
 * are dispatched by `decodeThumb` based on the top bits of the opcode.
 */

import { notePopGba, notePushGba } from "../debug/call-stack.js";
import type { MemoryBus } from "../memory/bus.js";
import {
  alu,
  ALU_ADC,
  ALU_ADD,
  ALU_AND,
  ALU_BIC,
  ALU_CMN,
  ALU_CMP,
  ALU_EOR,
  ALU_MOV,
  ALU_MVN,
  ALU_ORR,
  ALU_RSB,
  ALU_SBC,
  ALU_SUB,
  ALU_TST,
  type AluOp,
  type AluResult
} from "./alu.js";
import { multiplyMCycles } from "./arm.js";
import { dispatchSwi } from "./bios-hle.js";
import { checkCondition } from "./conditions.js";
import type { ArmCpu } from "./cpu.js";
import { type ArmRegisters, CPSR_I, CPSR_T, MODE_SVC } from "./registers.js";
import {
  SHIFT_ASR,
  SHIFT_LSL,
  SHIFT_LSR,
  SHIFT_ROR,
  shiftByImmediate,
  shiftByRegister,
  type ShiftType
} from "./shifter.js";

/** Execute one Thumb-state instruction at `regs.r[15]`. The optional
 *  `cpu` parameter lets SWI calls reach the BIOS-HLE dispatcher; unit
 *  tests that drive `stepThumb` directly omit it and unhandled SWIs
 *  fall through to the regular ARM SVC exception entry. */
export function stepThumb(regs: ArmRegisters, bus: MemoryBus, cpu?: ArmCpu, prefetched?: number): void {
  const pc = regs.r[15]! | 0;
  // Prefer the FIFO-provided word; fall back to a bus fetch for
  // bare-CPU callers (unit tests that drive `stepThumb` directly).
  const instr = prefetched !== undefined ? prefetched & 0xffff : bus.read16(pc) & 0xffff;
  regs.r[15] = (pc + 2) | 0;

  // Default Thumb instruction cost is 1S; specific branches (load /
  // store / branch / multiply) override below.
  let cycles = 1;

  const top3 = (instr >>> 13) & 0x7;
  if (top3 === 0b000) {
    if (((instr >>> 11) & 0x3) === 0b11) {
      executeAddSub(regs, instr);
    } else {
      executeMoveShifted(regs, instr);
    }
    // 1 cycle
  } else if (top3 === 0b001) {
    executeImmediate(regs, instr);
    // 1 cycle
  } else if (top3 === 0b010) {
    if (((instr >>> 12) & 1) === 0) {
      const sub = (instr >>> 10) & 0x3;
      if (sub === 0b00) {
        executeAluOp(regs, instr);
        // ALU ops with register-shifted operand spend an extra I cycle.
        // The format 4 opcodes that read a shift register are LSL/LSR/ASR/ROR
        // (opcodes 0b0010, 0b0011, 0b0100, 0b0111).
        const op = (instr >>> 6) & 0xf;
        if (op === 0b0010 || op === 0b0011 || op === 0b0100 || op === 0b0111) cycles = 2;
        // Thumb MUL (op 0b1101) — same booth-recoder m factor as ARM MUL
        // per ARM7TDMI TRM. The destination is Rd (low reg), source for
        // booth is Rd (the multiplier). 1 cycle base + m internal cycles.
        else if (op === 0b1101) {
          const rd = instr & 0x7;
          cycles = 1 + multiplyMCycles(regs.r[rd]! | 0);
        }
      } else if (sub === 0b01) {
        // Hi-register / BX. BX (op=0b11) and writes to PC trigger a
        // pipeline refill, but the actual refill cost is region-aware
        // and paid on the next step's cache miss (`cacheMissCost`).
        // Leave `cycles` at 1 here so we don't double-count vs that.
        executeHiRegister(regs, instr);
      } else {
        executePcRelativeLoad(regs, bus, instr);
        cycles = 2; // internal 1S + 1I; bus charges data access
      }
    } else if (((instr >>> 9) & 1) === 0) {
      executeLoadStoreReg(regs, bus, instr);
      const isLoad = ((instr >>> 11) & 1) === 1;
      cycles = isLoad ? 2 : 1;
    } else {
      executeLoadStoreSign(regs, bus, instr);
      const isLoad = ((instr >>> 11) & 3) !== 0; // L bit set or H signed
      cycles = isLoad ? 2 : 1;
    }
  } else if (top3 === 0b011) {
    executeLoadStoreImm(regs, bus, instr);
    const isLoad = ((instr >>> 11) & 1) === 1;
    cycles = isLoad ? 2 : 1;
  } else if (top3 === 0b100) {
    if (((instr >>> 12) & 1) === 0) {
      executeLoadStoreHalfword(regs, bus, instr);
    } else {
      executeLoadStoreSpRelative(regs, bus, instr);
    }
    const isLoad = ((instr >>> 11) & 1) === 1;
    cycles = isLoad ? 2 : 1;
  } else if (top3 === 0b101) {
    if (((instr >>> 12) & 1) === 0) {
      executeLoadAddress(regs, instr);
      // 1 cycle (ADR)
    } else {
      const sub = (instr >>> 9) & 0x3;
      if (sub === 0b00) {
        executeSpAdjust(regs, instr);
        // 1 cycle
      } else if (sub === 0b10) {
        executePushPop(regs, bus, instr);
        // Internal cost only — bus charges per-register data cycles.
        // POP-with-PC's pipeline-refill cost is region-aware and paid
        // on the next step's cache miss.
        const isLoad = ((instr >>> 11) & 1) === 1;
        cycles = isLoad ? 2 : 1;
      }
      // Other bits-11:9 patterns are unallocated NOPs — 1 cycle.
    }
  } else if (top3 === 0b110) {
    if (((instr >>> 12) & 1) === 0) {
      executeLoadStoreMultiple(regs, bus, instr);
      // Internal: 2 cycles for load (1S + 1I), 1 for store. Bus
      // charges the per-register data cycles separately.
      const isLoad = ((instr >>> 11) & 1) === 1;
      cycles = isLoad ? 2 : 1;
    } else {
      const cond = (instr >>> 8) & 0xf;
      if (cond === 0xf) {
        executeThumbSwi(regs, bus, instr, cpu);
        // SVC exception entry's refill is region-aware via cacheMissCost.
      } else if (cond === 0xe) {
        throw new Error(
          `Undefined Thumb encoding (cond=0xE) at PC=0x${pc.toString(16)}: 0x${instr.toString(16).padStart(4, "0")}`
        );
      } else {
        executeCondBranch(regs, instr, cond);
        // Both taken and untaken branches cost 1 cycle internally;
        // taken branches' pipeline-refill cost is paid via the next
        // step's `cacheMissCost`. (Region-aware: 1 cycle each in
        // internal regions, N + 2S in cart-ROM.)
      }
    }
  } else if (top3 === 0b111) {
    if (((instr >>> 12) & 1) === 0) {
      executeUncondBranch(regs, instr);
      // Branch refill handled by next step's cacheMissCost.
    } else {
      executeLongBranchLink(regs, instr);
      // Format 19: first half just sets up LR (1 cycle), second half
      // branches. The branch-half's refill is region-aware and paid
      // on the next step's cache miss, so both halves cost 1 cycle.
    }
  } else {
    throw new Error(
      `Unimplemented Thumb instruction (top 0b${top3.toString(2).padStart(3, "0")}) at PC=0x${pc.toString(16)}: 0x${instr.toString(16).padStart(4, "0")}`
    );
  }

  if (cpu !== undefined) cpu.lastCycles = cycles;
}

/** Format 1 — move shifted register: `Rd = Rs <shift> #imm5`.
 *  Always sets N/Z/C; V is preserved. The barrel shifter handles
 *  the imm5=0 special cases (LSR/ASR #0 → #32, LSL #0 → no shift). */
function executeMoveShifted(regs: ArmRegisters, instr: number): void {
  const op = (instr >>> 11) & 0x3;
  const offset = (instr >>> 6) & 0x1f;
  const rs = (instr >>> 3) & 0x7;
  const rd = instr & 0x7;
  // op ∈ {0, 1, 2} — bits-12:11 = 11 was already filtered out into
  // executeAddSub in the dispatcher.
  const shiftType: ShiftType = op === 0 ? SHIFT_LSL : op === 1 ? SHIFT_LSR : SHIFT_ASR;
  const result = shiftByImmediate(regs.r[rs]! | 0, shiftType, offset, regs.cFlag);
  regs.r[rd] = result.value;
  regs.nFlag = result.value < 0;
  regs.zFlag = result.value === 0;
  regs.cFlag = result.carryOut;
}

/** Format 2 — add/subtract: `Rd = Rs ± (Rn | #imm3)`. Always sets
 *  N/Z/C/V from the arithmetic result. */
function executeAddSub(regs: ArmRegisters, instr: number): void {
  const isImm = ((instr >>> 10) & 1) === 1;
  const isSub = ((instr >>> 9) & 1) === 1;
  const arg = (instr >>> 6) & 0x7;
  const rs = (instr >>> 3) & 0x7;
  const rd = instr & 0x7;
  const op2 = isImm ? arg : regs.r[arg]! | 0;
  const op: AluOp = isSub ? ALU_SUB : ALU_ADD;
  const result = alu(op, regs.r[rs]! | 0, op2, regs.cFlag, regs.vFlag, regs.cFlag);
  regs.r[rd] = result.value;
  regs.nFlag = result.flags.n;
  regs.zFlag = result.flags.z;
  regs.cFlag = result.flags.c;
  regs.vFlag = result.flags.v;
}

/** Format 3 — MOV/CMP/ADD/SUB with an 8-bit unsigned immediate.
 *  MOV/ADD/SUB write back to Rd; CMP discards the result. All four
 *  set N/Z; ADD/SUB/CMP also set C/V from the arithmetic. MOV's
 *  immediate is 0–255 so N is always zero anyway; C/V come from the
 *  ALU helper's preserve-V/preserve-C paths and stay unchanged. */
function executeImmediate(regs: ArmRegisters, instr: number): void {
  const op = (instr >>> 11) & 0x3;
  const rd = (instr >>> 8) & 0x7;
  const imm = instr & 0xff;
  let aluOp: AluOp;
  let rn: number;
  let writeBack = true;
  switch (op) {
    case 0:
      aluOp = ALU_MOV;
      rn = 0;
      break;
    case 1:
      aluOp = ALU_CMP;
      rn = regs.r[rd]! | 0;
      writeBack = false;
      break;
    case 2:
      aluOp = ALU_ADD;
      rn = regs.r[rd]! | 0;
      break;
    case 3:
      aluOp = ALU_SUB;
      rn = regs.r[rd]! | 0;
      break;
    default:
      throw new Error("unreachable");
  }
  const result = alu(aluOp, rn, imm, regs.cFlag, regs.vFlag, regs.cFlag);
  if (writeBack) regs.r[rd] = result.value;
  regs.nFlag = result.flags.n;
  regs.zFlag = result.flags.z;
  regs.cFlag = result.flags.c;
  regs.vFlag = result.flags.v;
}

/** Format 4 — ALU operations on low registers (R0–R7).
 *
 *  16 op codes split across four flag-update conventions:
 *    • Logical (AND/EOR/TST/ORR/BIC/MVN): N/Z updated, C/V preserved.
 *    • Shift-by-register (LSL/LSR/ASR/ROR): N/Z/C from the shifter,
 *      V preserved. The barrel shifter returns the correct carry-out
 *      and handles the Rs=0 "preserve C" case.
 *    • Arithmetic (ADC/SBC/NEG/CMP/CMN): all four flags from the ALU.
 *      NEG (op 1001) is RSB Rd, Rs, #0.
 *    • MUL (op 1101): N/Z from the 32-bit product. C is documented
 *      as "destroyed" on ARM7TDMI — we leave it unchanged (the
 *      common convention); V is preserved.
 *
 *  TST / CMP / CMN don't write Rd. */
// Module-level helpers — keeping these out of `executeAluOp`'s body
// avoids esbuild's `__name(fn, "name")` wrapper firing on every call
// (which would otherwise be one Object.defineProperty per Thumb ALU
// op, ~7% of total runtime on SMA2).
function writeAluResultFlags(regs: ArmRegisters, rd: number, result: AluResult, writeBack: boolean): void {
  if (writeBack) regs.r[rd] = result.value;
  regs.nFlag = result.flags.n;
  regs.zFlag = result.flags.z;
  regs.cFlag = result.flags.c;
  regs.vFlag = result.flags.v;
}
function writeShiftResultFlags(regs: ArmRegisters, rd: number, value: number, carry: boolean): void {
  regs.r[rd] = value;
  regs.nFlag = value < 0;
  regs.zFlag = value === 0;
  regs.cFlag = carry;
}

function executeAluOp(regs: ArmRegisters, instr: number): void {
  const op = (instr >>> 6) & 0xf;
  const rs = (instr >>> 3) & 0x7;
  const rd = instr & 0x7;
  const rdValue = regs.r[rd]! | 0;
  const rsValue = regs.r[rs]! | 0;

  switch (op) {
    case 0b0000:
      writeAluResultFlags(regs, rd, alu(ALU_AND, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    case 0b0001:
      writeAluResultFlags(regs, rd, alu(ALU_EOR, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    case 0b0010: {
      const r = shiftByRegister(rdValue, SHIFT_LSL, rsValue & 0xff, regs.cFlag);
      writeShiftResultFlags(regs, rd, r.value, r.carryOut);
      return;
    }
    case 0b0011: {
      const r = shiftByRegister(rdValue, SHIFT_LSR, rsValue & 0xff, regs.cFlag);
      writeShiftResultFlags(regs, rd, r.value, r.carryOut);
      return;
    }
    case 0b0100: {
      const r = shiftByRegister(rdValue, SHIFT_ASR, rsValue & 0xff, regs.cFlag);
      writeShiftResultFlags(regs, rd, r.value, r.carryOut);
      return;
    }
    case 0b0101:
      writeAluResultFlags(regs, rd, alu(ALU_ADC, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    case 0b0110:
      writeAluResultFlags(regs, rd, alu(ALU_SBC, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    case 0b0111: {
      const r = shiftByRegister(rdValue, SHIFT_ROR, rsValue & 0xff, regs.cFlag);
      writeShiftResultFlags(regs, rd, r.value, r.carryOut);
      return;
    }
    case 0b1000:
      writeAluResultFlags(regs, rd, alu(ALU_TST, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), false);
      return;
    case 0b1001:
      // NEG Rd, Rs ≡ RSB Rd, Rs, #0 → Rd = 0 - Rs.
      writeAluResultFlags(regs, rd, alu(ALU_RSB, rsValue, 0, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    case 0b1010:
      writeAluResultFlags(regs, rd, alu(ALU_CMP, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), false);
      return;
    case 0b1011:
      writeAluResultFlags(regs, rd, alu(ALU_CMN, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), false);
      return;
    case 0b1100:
      writeAluResultFlags(regs, rd, alu(ALU_ORR, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    case 0b1101: {
      const product = Math.imul(rdValue, rsValue) | 0;
      regs.r[rd] = product;
      regs.nFlag = product < 0;
      regs.zFlag = product === 0;
      // C destroyed on ARM7TDMI; V preserved. We leave both alone.
      return;
    }
    case 0b1110:
      writeAluResultFlags(regs, rd, alu(ALU_BIC, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    case 0b1111:
      writeAluResultFlags(regs, rd, alu(ALU_MVN, 0, rsValue, regs.cFlag, regs.vFlag, regs.cFlag), true);
      return;
    default:
      throw new Error(`Unreachable Thumb format-4 op: ${op}`);
  }
}

/** Read a Thumb-state register, applying the PC+4 prefetch quirk
 *  when the register is R15. After stepThumb's PC advance, current
 *  r[15] == instruction_addr + 2, so the visible PC value is
 *  r[15] + 2. */
function readThumbReg(regs: ArmRegisters, n: number): number {
  return n === 15 ? ((regs.r[15]! | 0) + 2) | 0 : regs.r[n]! | 0;
}

/** Format 5 — hi-register operations + branch exchange.
 *
 *  Op 00 = ADD, 01 = CMP, 10 = MOV, 11 = BX. H1 (bit 7) selects the
 *  high half of Rd; H2 (bit 6) selects the high half of Rs. After
 *  extension, both Rd and Rs can address any of R0–R15.
 *
 *  ADD and MOV do NOT update flags (the only Thumb data-processing
 *  ops with this property — easy to forget). CMP updates all four
 *  flags via the regular CMP path. BX branches to Rs and switches
 *  state based on the target's bit 0 (set → Thumb, clear → ARM). */
function executeHiRegister(regs: ArmRegisters, instr: number): void {
  const op = (instr >>> 8) & 0x3;
  const h1 = ((instr >>> 7) & 1) === 1;
  const h2 = ((instr >>> 6) & 1) === 1;
  const rs = ((h2 ? 1 : 0) << 3) | ((instr >>> 3) & 0x7);
  const rd = ((h1 ? 1 : 0) << 3) | (instr & 0x7);

  if (op === 0b11) {
    // BX. H1 must be 0 on ARM7TDMI; H1=1 is the BLX encoding slot,
    // which is undefined here.
    if (h1) {
      throw new Error(`BLX (Thumb hi-reg op 11 with H1=1) is undefined on ARM7TDMI`);
    }
    // Call-stack tap: Thumb BX is the standard function return
    // (`bx lr`). Pop best-effort — non-return uses still pop.
    notePopGba();
    const target = readThumbReg(regs, rs);
    if ((target & 1) === 0) {
      regs.cpsr = (regs.cpsr & ~CPSR_T) | 0;
      regs.r[15] = target & ~3;
    } else {
      regs.r[15] = target & ~1;
    }
    return;
  }

  // ADD/CMP/MOV with H1=H2=0 collide with format-4 ADD/CMP/MOV and
  // are documented as unpredictable. Real ARM7TDMI just runs them as
  // hi-register variants of the same op, which is what we do here —
  // erring loudly would break legitimate code that happens to land
  // on this encoding.
  const rsValue = readThumbReg(regs, rs);
  const rdValue = readThumbReg(regs, rd);

  switch (op) {
    case 0b00: {
      const value = (rdValue + rsValue) | 0;
      if (rd === 15) {
        regs.r[15] = value & ~1;
      } else {
        regs.r[rd] = value;
      }
      return;
    }
    case 0b01: {
      const result = alu(ALU_CMP, rdValue, rsValue, regs.cFlag, regs.vFlag, regs.cFlag);
      regs.nFlag = result.flags.n;
      regs.zFlag = result.flags.z;
      regs.cFlag = result.flags.c;
      regs.vFlag = result.flags.v;
      return;
    }
    case 0b10: {
      if (rd === 15) {
        regs.r[15] = rsValue & ~1;
      } else {
        regs.r[rd] = rsValue;
      }
      return;
    }
    default:
      throw new Error(`Unreachable Thumb hi-register op: ${op}`);
  }
}

/** ARM7TDMI word LDR with the alignment-rotate quirk: the word at
 *  `addr & ~3` is loaded and then rotated right by `8 × (addr & 3)`
 *  so the byte at the unaligned address ends up in bits 7:0. */
function loadWordRotated(bus: MemoryBus, addr: number): number {
  const rotate = (addr & 3) * 8;
  const raw = bus.read32(addr >>> 0) | 0;
  return rotate === 0 ? raw : (raw >>> rotate) | (raw << (32 - rotate)) | 0;
}

/** ARM7TDMI LDRH at a misaligned (odd) address is officially
 *  UNPREDICTABLE per the ARM ARM. The behaviour real silicon actually
 *  ships — required by T&J Tales, which derives Jerry's sprite-
 *  palette index from a deliberate byte-offset-1 halfword load — is:
 *    Rd = byte_at(addr), zero-extended to 32 bits.
 *  i.e. a misaligned LDRH degrades to LDRB at the addressed byte.
 *  The previous "byte-swap within 16 bits" interpretation set bit 8
 *  in the result via the high byte of the aligned halfword, sending
 *  the cart's `r5 << 5` SAD-offset computation into a different
 *  palette bank and rendering Jerry gray. */
function loadHalfwordRotated(bus: MemoryBus, addr: number): number {
  if ((addr & 1) === 0) return bus.read16(addr >>> 0) & 0xffff;
  return bus.read8(addr >>> 0) & 0xff;
}

/** Format 6 — PC-relative load: `LDR Rd, [PC, #imm8 << 2]`. The
 *  base is the visible PC value (`instruction_addr + 4`) forced to
 *  word alignment by masking bit 1. Used by Thumb code to
 *  materialize 32-bit constants since the inline immediates aren't
 *  wide enough. */
function executePcRelativeLoad(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const rd = (instr >>> 8) & 0x7;
  const offset = (instr & 0xff) << 2;
  // Current r[15] = instruction_addr + 2; PC reads as +4, then word-align.
  const base = (((regs.r[15]! | 0) + 2) & ~3) >>> 0;
  regs.r[rd] = bus.read32(((base + offset) | 0) >>> 0) | 0;
}

/** Format 7 — load/store with register offset, word or byte. */
function executeLoadStoreReg(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isLoad = ((instr >>> 11) & 1) === 1;
  const isByte = ((instr >>> 10) & 1) === 1;
  const ro = (instr >>> 6) & 0x7;
  const rb = (instr >>> 3) & 0x7;
  const rd = instr & 0x7;
  const addr = ((regs.r[rb]! | 0) + (regs.r[ro]! | 0)) | 0;

  if (isLoad) {
    regs.r[rd] = isByte ? bus.read8(addr >>> 0) : loadWordRotated(bus, addr);
    return;
  }
  if (isByte) {
    bus.write8(addr >>> 0, (regs.r[rd]! | 0) & 0xff);
  } else {
    bus.write32(addr >>> 0, regs.r[rd]! | 0);
  }
}

/** Format 8 — load/store sign-extended byte and halfword with
 *  register offset. The (S, H) bit pair encodes the operation:
 *  (0, 0) STRH, (0, 1) LDRH, (1, 0) LDSB, (1, 1) LDSH. */
function executeLoadStoreSign(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const h = ((instr >>> 11) & 1) === 1;
  const s = ((instr >>> 10) & 1) === 1;
  const ro = (instr >>> 6) & 0x7;
  const rb = (instr >>> 3) & 0x7;
  const rd = instr & 0x7;
  const addr = ((regs.r[rb]! | 0) + (regs.r[ro]! | 0)) | 0;

  if (!s && !h) {
    // STRH
    bus.write16(addr >>> 0, (regs.r[rd]! | 0) & 0xffff);
    return;
  }
  if (!s && h) {
    // LDRH (with misaligned byte-swap quirk)
    regs.r[rd] = loadHalfwordRotated(bus, addr);
    return;
  }
  if (s && !h) {
    // LDSB — sign-extend a byte to 32 bits
    const byte = bus.read8(addr >>> 0);
    regs.r[rd] = (byte << 24) >> 24;
    return;
  }
  // LDSH — sign-extend a halfword to 32 bits. On a misaligned
  // address, ARM7TDMI behaves as LDSB on the addressed byte.
  if ((addr & 1) !== 0) {
    const byte = bus.read8(addr >>> 0);
    regs.r[rd] = (byte << 24) >> 24;
  } else {
    const raw = bus.read16(addr >>> 0) & 0xffff;
    regs.r[rd] = (raw << 16) >> 16;
  }
}

/** Format 9 — load/store with 5-bit immediate offset (scaled by 4
 *  for word, by 1 for byte). */
function executeLoadStoreImm(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isByte = ((instr >>> 12) & 1) === 1;
  const isLoad = ((instr >>> 11) & 1) === 1;
  const offset = ((instr >>> 6) & 0x1f) * (isByte ? 1 : 4);
  const rb = (instr >>> 3) & 0x7;
  const rd = instr & 0x7;
  const addr = ((regs.r[rb]! | 0) + offset) | 0;

  if (isLoad) {
    regs.r[rd] = isByte ? bus.read8(addr >>> 0) : loadWordRotated(bus, addr);
    return;
  }
  if (isByte) {
    bus.write8(addr >>> 0, (regs.r[rd]! | 0) & 0xff);
  } else {
    bus.write32(addr >>> 0, regs.r[rd]! | 0);
  }
}

/** Format 10 — load/store halfword with 5-bit immediate offset
 *  (scaled by 2). LDRH zero-extends; STRH stores the low 16 bits. */
function executeLoadStoreHalfword(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isLoad = ((instr >>> 11) & 1) === 1;
  const offset = ((instr >>> 6) & 0x1f) << 1;
  const rb = (instr >>> 3) & 0x7;
  const rd = instr & 0x7;
  const addr = ((regs.r[rb]! | 0) + offset) | 0;

  if (isLoad) {
    regs.r[rd] = loadHalfwordRotated(bus, addr);
  } else {
    bus.write16(addr >>> 0, (regs.r[rd]! | 0) & 0xffff);
  }
}

/** Format 11 — SP-relative load/store: `LDR/STR Rd, [SP, #imm8 << 2]`.
 *  Word-width only; encodes the stack-frame access pattern that the
 *  Thumb push/pop family enables. */
function executeLoadStoreSpRelative(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isLoad = ((instr >>> 11) & 1) === 1;
  const rd = (instr >>> 8) & 0x7;
  const offset = (instr & 0xff) << 2;
  const addr = ((regs.r[13]! | 0) + offset) | 0;

  if (isLoad) {
    regs.r[rd] = loadWordRotated(bus, addr);
  } else {
    bus.write32(addr >>> 0, regs.r[rd]! | 0);
  }
}

/** Format 12 — Load address: `ADD Rd, PC|SP, #imm8 << 2`. The PC
 *  variant uses the visible PC (`instruction_addr + 4`) forced to
 *  word alignment — the same base as PC-relative LDR. */
function executeLoadAddress(regs: ArmRegisters, instr: number): void {
  const useSp = ((instr >>> 11) & 1) === 1;
  const rd = (instr >>> 8) & 0x7;
  const offset = (instr & 0xff) << 2;
  // Current r[15] = instruction_addr + 2; PC reads as +4, then word-align.
  const base = useSp ? regs.r[13]! | 0 : ((regs.r[15]! | 0) + 2) & ~3;
  regs.r[rd] = (base + offset) | 0;
}

/** Format 13 — Add offset to stack pointer: `ADD/SUB SP, #imm7 << 2`.
 *  No flags update. */
function executeSpAdjust(regs: ArmRegisters, instr: number): void {
  const isSub = ((instr >>> 7) & 1) === 1;
  const offset = (instr & 0x7f) << 2;
  const sp = regs.r[13]! | 0;
  regs.r[13] = (isSub ? sp - offset : sp + offset) | 0;
}

/** Format 14 — Push/pop registers.
 *
 *  PUSH (L=0) is `STMDB SP!, {Rlist[, LR]}` — full descending: SP is
 *  pre-decremented by 4 per register, then registers are stored at
 *  ascending addresses (lowest register at lowest address).
 *
 *  POP (L=1) is `LDMIA SP!, {Rlist[, PC]}` — registers loaded from
 *  ascending addresses, then SP is post-incremented.
 *
 *  POP {PC} on ARMv4T (ARM7TDMI) does NOT interwork — PC is loaded
 *  from the stack but the T-bit stays set, and bits [1:0] of the
 *  loaded value are ignored. (ARMv5T added the interworking behaviour;
 *  this is the older ARMv4T semantics MMBN's IRQ glue depends on.) */
function executePushPop(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isPop = ((instr >>> 11) & 1) === 1;
  const extra = ((instr >>> 8) & 1) === 1;
  const rlist = instr & 0xff;

  let count = 0;
  for (let i = 0; i < 8; i++) if ((rlist & (1 << i)) !== 0) count++;
  if (extra) count++;
  if (count === 0) {
    throw new Error(`Empty register list in Thumb PUSH/POP is unpredictable on ARM7TDMI`);
  }
  const totalSize = count * 4;
  const sp = regs.r[13]! | 0;

  if (isPop) {
    // Call-stack tap: POP {..., pc} is the canonical Thumb function-
    // epilogue pattern (prologue pushed lr + callee-saves). Pop the
    // top frame when PC is in the loaded set.
    if (extra) notePopGba();
    let addr = sp;
    for (let i = 0; i < 8; i++) {
      if ((rlist & (1 << i)) === 0) continue;
      regs.r[i] = bus.read32(addr >>> 0) | 0;
      addr = (addr + 4) | 0;
    }
    if (extra) {
      const value = bus.read32(addr >>> 0) | 0;
      regs.r[15] = value & ~1;
      addr = (addr + 4) | 0;
    }
    regs.r[13] = (sp + totalSize) | 0;
    return;
  }

  // PUSH
  let addr = (sp - totalSize) | 0;
  for (let i = 0; i < 8; i++) {
    if ((rlist & (1 << i)) === 0) continue;
    bus.write32(addr >>> 0, regs.r[i]! | 0);
    addr = (addr + 4) | 0;
  }
  if (extra) {
    bus.write32(addr >>> 0, regs.r[14]! | 0);
  }
  regs.r[13] = (sp - totalSize) | 0;
}

/** Format 15 — Multiple load/store: `LDMIA/STMIA Rb!, {Rlist}`.
 *
 *  Edge cases (ARM7TDMI):
 *   - Empty rlist (R0..R7 all clear): no register transferred, base
 *     advances by 0x40 (count = 16 in the equivalent ARM encoding).
 *   - Rb in rlist + writeback:
 *      - STMIA: if Rb is first in list, the ORIGINAL value of Rb is
 *        stored; otherwise the WRITEBACK value is stored.
 *      - LDMIA: the loaded value wins (no writeback for Rb).
 *  nba-hw-test's bus/128kb-boundary exercises the LDMIA case. */
function executeLoadStoreMultiple(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isLoad = ((instr >>> 11) & 1) === 1;
  const rb = (instr >>> 8) & 0x7;
  const rlist = instr & 0xff;

  const baseValue = regs.r[rb]! | 0;
  if (rlist === 0) {
    regs.r[rb] = (baseValue + 0x40) | 0;
    return;
  }

  let count = 0;
  for (let i = 0; i < 8; i++) if ((rlist & (1 << i)) !== 0) count++;
  const totalSize = count * 4;
  const rbInRlist = (rlist & (1 << rb)) !== 0;
  const rbIsFirstInList = rbInRlist && (rlist & ((1 << rb) - 1)) === 0;
  let addr = baseValue;

  if (isLoad) {
    for (let i = 0; i < 8; i++) {
      if ((rlist & (1 << i)) === 0) continue;
      regs.r[i] = bus.read32(addr >>> 0) | 0;
      addr = (addr + 4) | 0;
    }
    if (!rbInRlist) regs.r[rb] = (baseValue + totalSize) | 0;
  } else {
    for (let i = 0; i < 8; i++) {
      if ((rlist & (1 << i)) === 0) continue;
      let v = regs.r[i]! | 0;
      if (i === rb && rbInRlist && !rbIsFirstInList) v = (baseValue + totalSize) | 0;
      bus.write32(addr >>> 0, v);
      addr = (addr + 4) | 0;
    }
    regs.r[rb] = (baseValue + totalSize) | 0;
  }
}

/** Format 16 — conditional branch: `B<cond> #imm8 << 1`. Target =
 *  (PC + 4) + sign_extend(imm8) * 2. Cond = 0xE collides with the
 *  encoding family and is undefined; cond = 0xF is SWI (format 17).
 *  Both are filtered out in the dispatcher. */
function executeCondBranch(regs: ArmRegisters, instr: number, cond: number): void {
  if (!checkCondition(cond, regs.cpsr)) return;
  const signed = ((instr & 0xff) << 24) >> 24;
  const offset = signed << 1;
  regs.r[15] = (((regs.r[15]! | 0) + 2 + offset) | 0) & ~1;
}

/** Format 17 — Thumb SWI. With a real BIOS loaded the SWI handler at
 *  0x08 runs naturally — cycle-accurate to the millisecond. Without
 *  BIOS the HLE dispatcher in `bios-hle.ts` simulates the call in
 *  TypeScript and returns directly. Mirrors the ARM `executeSwi` gate:
 *  HLE must NOT preempt real BIOS, otherwise SWI cycle costs differ
 *  between ARM SWIs (which used to take the real path) and Thumb SWIs
 *  (which always HLE'd) — that mismatch was visible as
 *  nba-haltcnt's HALTCNT TIME ROM running −145 cycles too fast. */
function executeThumbSwi(regs: ArmRegisters, bus: MemoryBus, instr: number, cpu?: ArmCpu): void {
  // SWI 0x04 (IntrWait) / 0x05 (VBlankIntrWait) routed through HLE
  // even with real BIOS — see ARM executeSwi for rationale (cart
  // handlers that clobber R4 deadlock the real-BIOS IntrWait loop).
  if (cpu && cpu.interrupts) {
    const swiNumber = instr & 0xff;
    if ((swiNumber === 0x04 || swiNumber === 0x05) && dispatchSwi(swiNumber, regs, bus, cpu, cpu.interrupts)) return;
  }
  if (cpu && cpu.interrupts && !cpu.hasBios) {
    if (dispatchSwi(instr & 0xff, regs, bus, cpu, cpu.interrupts)) return;
    // Unimplemented SWI in no-BIOS mode: silently skip (see ARM
    // executeSwi for the rationale — NOP-sliding to PC=0x18 fires a
    // spurious IRQ entry and corrupts state).
    return;
  }
  const oldCpsr = regs.cpsr;
  const returnAddress = regs.r[15]! | 0;
  regs.setMode(MODE_SVC);
  regs.spsr = oldCpsr;
  regs.r[14] = returnAddress;
  regs.cpsr = ((regs.cpsr | CPSR_I) & ~CPSR_T) | 0;
  regs.r[15] = 0x08;
}

/** Format 18 — unconditional branch: `B #imm11 << 1`. Target =
 *  (PC + 4) + sign_extend(imm11) * 2. Used by short forward/backward
 *  jumps within ±2 KB. */
function executeUncondBranch(regs: ArmRegisters, instr: number): void {
  const signed = ((instr & 0x7ff) << 21) >> 21;
  const offset = signed << 1;
  regs.r[15] = (((regs.r[15]! | 0) + 2 + offset) | 0) & ~1;
}

/** Format 19 — long branch with link. Encoded as two consecutive
 *  Thumb halfwords:
 *
 *    First  (H=0, top5 = 11110): LR ← PC + 4 + sign_extend(off11) << 12
 *    Second (H=1, top5 = 11111): temp = next-instruction address;
 *                                PC  ← LR + (off11 << 1)
 *                                LR  ← temp | 1
 *
 *  The two halfwords are executed as ordinary independent
 *  instructions — there's no inter-instruction state to track
 *  beyond the LR register. The `| 1` on the saved return address
 *  marks it as a Thumb target, so a subsequent BX LR stays in Thumb
 *  state. */
function executeLongBranchLink(regs: ArmRegisters, instr: number): void {
  const isSecond = ((instr >>> 11) & 1) === 1;
  const off11 = instr & 0x7ff;
  if (!isSecond) {
    const signed = (off11 << 21) >> 21;
    const offsetHigh = signed << 12;
    regs.r[14] = (((regs.r[15]! | 0) + 2 + offsetHigh) | 0) & ~0;
    return;
  }
  const offsetLow = off11 << 1;
  const lr = regs.r[14]! | 0;
  const returnAddress = (regs.r[15]! | 0 | 1) >>> 0;
  // Call-stack tap: second half of a Thumb BL pair is the actual
  // call. callSite is the BL itself = current PC - 2 (r15 advanced
  // past this halfword's fetch).
  notePushGba({
    callSite: ((regs.r[15]! | 0) - 2) >>> 0,
    returnAddr: returnAddress >>> 0,
    kind: "call"
  });
  regs.r[15] = ((lr + offsetLow) | 0) & ~1;
  regs.r[14] = returnAddress | 0;
}
