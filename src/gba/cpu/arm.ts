/**
 * ARM-state instruction dispatch + data-processing executor.
 *
 * Pipeline emulation: the ARM7TDMI prefetches two words ahead, so when
 * code reads R15 the visible value is PC + 8 (where PC is the address
 * of the executing instruction). When R15 is the source of a register-
 * shifted operand, the extra cycle for the shift register fetch pushes
 * that read to PC + 12. Both quirks are emulated below by adding 4 or
 * 8 to r[15] on read (r[15] having already been advanced by 4 in
 * `stepArm`, so its value here is "address-of-next-fetch" = PC + 4).
 *
 * Coverage: data processing + branches (B / BL / BX) + single data
 * transfer (LDR / STR / LDRB / STRB) + block data transfer (LDM / STM,
 * including S-bit exception-return + user-bank forms) + halfword +
 * signed data transfer (LDRH / STRH / LDRSB / LDRSH) + multiply (MUL /
 * MLA / UMULL / UMLAL / SMULL / SMLAL) + PSR transfer (MRS / MSR) +
 * single data swap (SWP / SWPB) + software interrupt (SWI). Only
 * coprocessor instructions still throw — the GBA hardware doesn't
 * expose a coprocessor.
 */

import { notePopGba, notePushGba } from "../debug/call-stack.js";
import type { MemoryBus } from "../memory/bus.js";
import { alu, type AluOp } from "./alu.js";
import { dispatchSwi } from "./bios-hle.js";
import { checkCondition } from "./conditions.js";
import type { ArmCpu } from "./cpu.js";
import { type ArmRegisters, CPSR_I, CPSR_T, MODE_SVC, MODE_SYS, MODE_USR } from "./registers.js";
import { shiftByImmediate, shiftByRegister, type ShiftType } from "./shifter.js";

/** BX encoding fingerprint — bits 27:4 are fixed at 0x12FFF1 (the
 *  remaining 4 bits hold Rn). BX shares its top-level class with
 *  data-processing instructions, so we check for it explicitly
 *  before falling through to the data-processing decoder. */
const BX_BITS_27_4 = 0x12fff1;

/** Execute one ARM-state instruction at `regs.r[15]`. Advances PC by
 *  4 before decode (matching the prefetch model: the instruction at
 *  the original PC observes r[15] as original_PC + 8). Sets
 *  `cpu.lastCycles` to the instruction's cycle cost (1S minimum;
 *  loads/stores/branches/multiplies cost more). The numbers assume
 *  all memory accesses hit fast (1-cycle) regions — WAITCNT-shaped
 *  wait states are a later phase. */
export function stepArm(regs: ArmRegisters, bus: MemoryBus, cpu?: ArmCpu, prefetched?: number): void {
  const pc = regs.r[15]! | 0;
  // Prefer the FIFO-provided word; fall back to a bus fetch for
  // bare-CPU callers (unit tests that drive `stepArm` directly with
  // a FlatBus) where the prefetch FIFO isn't maintained.
  const instr = prefetched !== undefined ? prefetched | 0 : bus.read32(pc) | 0;
  regs.r[15] = (pc + 4) | 0;

  const cond = (instr >>> 28) & 0xf;
  if (!checkCondition(cond, regs.cpsr)) {
    // Condition-fail still consumes one S cycle (the fetch is what
    // burns it; the execute stage just becomes a no-op).
    if (cpu !== undefined) cpu.lastCycles = 1;
    return;
  }

  const cls = (instr >>> 25) & 0x7;
  if (cls === 0b101) {
    executeBranch(regs, instr);
    // 1 cycle for the branch's own execute stage. The 2S + 1N pipeline
    // refill happens on the next step's cache miss, where `cacheMissCost`
    // picks up the actual region-aware fetch cost (1 cycle each in
    // internal regions, N + 2S in cart-ROM via the bus's WAITCNT table).
    // Baking 3 cycles in here would double-count the refill against the
    // bus's contribution.
    if (cpu !== undefined) cpu.lastCycles = 1;
    return;
  }
  if (cls === 0b000 || cls === 0b001) {
    if (((instr >>> 4) & 0xffffff) === BX_BITS_27_4) {
      executeBx(regs, instr);
      if (cpu !== undefined) cpu.lastCycles = 1; // refill via cacheMissCost
      return;
    }
    if (cls === 0b000) {
      const bits74 = (instr >>> 4) & 0xf;
      // bits 7:4 = 1001: multiply (bit 24 = 0) or SWP (bit 24 = 1).
      if (bits74 === 0b1001) {
        if (((instr >>> 24) & 1) === 0) {
          executeMultiply(regs, instr);
          // ARM7TDMI multiply cycles (TRM §6.20):
          //   MUL/MLA  : 1S + mI         where m = booth-style early-
          //                              termination count on Rs (1..4).
          //   MLA      : 1S + (m+1)I
          //   UMULL/SMULL: 1S + (m+1)I
          //   UMLAL/SMLAL: 1S + (m+2)I
          // m comes from leading 0/1 runs in Rs:
          //   m = 1 if Rs[31:8]  is all 0 or all 1
          //   m = 2 if Rs[31:16] is all 0 or all 1
          //   m = 3 if Rs[31:24] is all 0 or all 1
          //   m = 4 otherwise
          // mgba-suite-timing probes 10 operand patterns per variant
          // — designed to exercise each m bucket.
          if (cpu !== undefined) {
            const rs = regs.r[(instr >>> 8) & 0xf]! | 0;
            const m = multiplyMCycles(rs);
            const isLong = ((instr >>> 23) & 1) === 1;
            const isAcc = ((instr >>> 21) & 1) === 1;
            cpu.lastCycles = 1 + m + (isAcc ? 1 : 0) + (isLong ? 1 : 0);
          }
        } else {
          executeSwp(regs, bus, instr);
          // Internal: 1S + 1I = 2. The two data accesses are charged
          // by the bus.
          if (cpu !== undefined) cpu.lastCycles = 2;
        }
        return;
      }
      // Halfword + signed data transfer (bits 7=1, 4=1, with S or H set).
      if ((bits74 & 0b1001) === 0b1001 && (bits74 & 0b0110) !== 0) {
        executeHalfwordTransfer(regs, bus, instr);
        // Internal cost only — the data access cycle is charged by
        // the bus. Load = 1S + 1I = 2; store = 1S = 1. Load-to-PC's
        // pipeline-refill cost is region-aware and paid on the next
        // step's cache miss (`cacheMissCost`).
        const isLoad = ((instr >>> 20) & 1) === 1;
        if (cpu !== undefined) cpu.lastCycles = isLoad ? 2 : 1;
        return;
      }
    }
    // PSR transfer (MRS / MSR) shares the TST/TEQ/CMP/CMN encoding slot
    // with S=0. Detect and dispatch before falling into data-processing.
    const op = (instr >>> 21) & 0xf;
    const setFlags = ((instr >>> 20) & 1) === 1;
    if (!setFlags && op >= 0b1000 && op <= 0b1011) {
      executePsrTransfer(regs, instr);
      if (cpu !== undefined) cpu.lastCycles = 1; // 1S
      return;
    }
    executeDataProcessing(regs, instr);
    // Data-processing: 1S base + 1I if the second operand is a
    // register-shifted-by-register form + 2 extra (1N + 1S) if PC is
    // the destination (pipeline refill).
    if (cpu !== undefined) {
      let dpCycles = 1;
      const isImmediateOp2 = ((instr >>> 25) & 1) === 1;
      if (!isImmediateOp2 && ((instr >>> 4) & 1) === 1) dpCycles += 1; // 1I
      const rd = (instr >>> 12) & 0xf;
      if (rd === 15) dpCycles += 2; // pipeline refill
      cpu.lastCycles = dpCycles;
    }
    return;
  }
  if (cls === 0b010 || cls === 0b011) {
    executeLoadStore(regs, bus, instr);
    // Internal cost only — bus charges the data-access cycle. Load:
    // 1S + 1I = 2. Store: 1S = 1. Load-to-PC pipeline refill is
    // region-aware and paid on the next step's cache miss.
    if (cpu !== undefined) {
      const isLoad = ((instr >>> 20) & 1) === 1;
      cpu.lastCycles = isLoad ? 2 : 1;
    }
    return;
  }
  if (cls === 0b100) {
    executeBlockTransfer(regs, bus, instr);
    // Bus charges per-register data cycles (S after the first N). We
    // pay just the internal cost: load 1S + 1I = 2, store 1S = 1.
    // LDM-with-PC's pipeline refill is paid on next step's cache miss.
    if (cpu !== undefined) {
      const isLoad = ((instr >>> 20) & 1) === 1;
      cpu.lastCycles = isLoad ? 2 : 1;
    }
    return;
  }
  if (cls === 0b110) {
    // Class 0b110 = coprocessor data transfer (LDC / STC). Falls into
    // the same bucket as 0b111 below: ARM7TDMI has no coprocessor, so
    // real hardware raises an undefined-instruction exception. We
    // don't HLE the UND vector — silently NOP so cart code that
    // probes the opcode space doesn't kill the run.
    if (cpu !== undefined) cpu.lastCycles = 1;
    return;
  }
  if (cls === 0b111) {
    if (((instr >>> 24) & 1) === 1) {
      executeSwi(regs, bus, instr, cpu);
      // 1 cycle for the SVC entry's own execute stage. The 2S + 1N
      // pipeline refill is paid on the next step's cache miss (region-
      // aware) via `cacheMissCost`.
      if (cpu !== undefined) cpu.lastCycles = 1;
      return;
    }
    // Coprocessor instructions (CDP / MCR / MRC) — ARM7TDMI has no
    // coprocessor, so real hardware raises an undefined-instruction
    // exception. mgba-suite-memory probes this expecting the CPU not
    // to die. We don't HLE the UND vector, so NOP the instruction
    // silently (same treatment as the LDR/STR bit-4 slot above).
    if (cpu !== undefined) cpu.lastCycles = 1;
    return;
  }

  throw new Error(
    `Unimplemented ARM instruction (class 0b${cls.toString(2).padStart(3, "0")}) at PC=0x${pc.toString(16)}: 0x${(instr >>> 0).toString(16).padStart(8, "0")}`
  );
}

/** B / BL — class 0b101. Bit 24 is the L flag (BL writes LR before
 *  branching). The 24-bit signed offset is sign-extended and shifted
 *  left by 2 to form a byte offset from PC+8. */
function executeBranch(regs: ArmRegisters, instr: number): void {
  const link = ((instr >>> 24) & 1) === 1;
  // (instr << 8) puts bit 23 at bit 31; arithmetic-right-shifting by 6
  // sign-extends and applies the ×4 scale in one step.
  const offset = (instr << 8) >> 6;
  const pcPlus8 = ((regs.r[15]! | 0) + 4) | 0;
  if (link) regs.r[14] = regs.r[15]! | 0;
  const target = ((pcPlus8 + offset) | 0) & ~3;
  if (link) {
    // Call-stack tap: BL writes LR to (instruction+4), branches to
    // target. The callSite is the BL itself (r15 - 4 here since r15
    // already advanced past the fetch).
    notePushGba({
      callSite: ((regs.r[15]! | 0) - 4) >>> 0,
      returnAddr: regs.r[14]! >>> 0,
      kind: "call"
    });
  }
  regs.r[15] = target;
}

/** BX Rn — class 0b000 with the fixed bit pattern matched in
 *  `stepArm`. Bit 0 of the target selects the next state: set →
 *  switch to Thumb, clear → stay in ARM. The bottom bits are
 *  masked off so the new PC is correctly aligned for the chosen
 *  state. */
function executeBx(regs: ArmRegisters, instr: number): void {
  const rn = instr & 0xf;
  const target = regs.r[rn]! | 0;
  // Call-stack tap: BX is conventionally how an ARM function returns
  // (typically `bx lr`). Pop a frame best-effort — non-return uses of
  // BX (jump tables, ARM↔Thumb hand-off) will incorrectly pop, but
  // the GB module accepts the same trade-off.
  notePopGba();
  if ((target & 1) !== 0) {
    regs.cpsr = regs.cpsr | CPSR_T;
    regs.r[15] = target & ~1;
  } else {
    regs.r[15] = target & ~3;
  }
}

/** Read a register, adjusting for the ARM PC+8/+12 pipeline quirk when
 *  the register is R15. `extraBeyondR15` is 4 (→ PC+8) for normal
 *  reads, 8 (→ PC+12) for the Rm-with-register-shift case. */
function readReg(regs: ArmRegisters, n: number, extraBeyondR15: number): number {
  return n === 15 ? ((regs.r[15]! | 0) + extraBeyondR15) | 0 : regs.r[n]! | 0;
}

function executeDataProcessing(regs: ArmRegisters, instr: number): void {
  const isImmediateOp2 = ((instr >>> 25) & 1) === 1;
  const op = ((instr >>> 21) & 0xf) as AluOp;
  const setFlags = ((instr >>> 20) & 1) === 1;
  const rn = (instr >>> 16) & 0xf;
  const rd = (instr >>> 12) & 0xf;

  // PSR transfer (TST/TEQ/CMP/CMN slot with S=0) is dispatched in
  // stepArm before reaching here, so the only remaining bit-7=1 case
  // in the shift-by-register branch below is a defensive throw — all
  // such encodings are handled upstream.

  // Operand-2 decode + barrel shift
  let op2: number;
  let shifterC: boolean;
  let rnExtra = 4; // R15 reads as PC+8 by default
  if (isImmediateOp2) {
    const rot = ((instr >>> 8) & 0xf) * 2;
    const imm = instr & 0xff;
    if (rot === 0) {
      op2 = imm;
      shifterC = regs.cFlag;
    } else {
      op2 = (imm >>> rot) | (imm << (32 - rot)) | 0;
      shifterC = op2 >>> 31 !== 0;
    }
  } else {
    const shiftType = ((instr >>> 5) & 0x3) as ShiftType;
    const rm = instr & 0xf;
    const shiftByReg = ((instr >>> 4) & 1) === 1;

    if (shiftByReg) {
      // Bit 7 must be 0 in this encoding. Multiply, SWP, and the
      // halfword/signed transfer family all set bit 7 = 1 and are
      // dispatched in stepArm before reaching here. Anything that
      // still lands in this slot with bit 7 = 1 is genuinely
      // unrecognised — defensive throw.
      if (((instr >>> 7) & 1) === 1) {
        throw new Error(
          `Unrecognised class-000 encoding with bit 7 set: instr 0x${(instr >>> 0).toString(16).padStart(8, "0")}`
        );
      }
      // Register-shifted operand: Rm sees PC+12 and Rn sees PC+12.
      rnExtra = 8;
      const rmValue = readReg(regs, rm, 8);
      const rs = (instr >>> 8) & 0xf;
      const amount = regs.r[rs]! & 0xff;
      const result = shiftByRegister(rmValue, shiftType, amount, regs.cFlag);
      op2 = result.value;
      shifterC = result.carryOut;
    } else {
      const rmValue = readReg(regs, rm, 4);
      const amount = (instr >>> 7) & 0x1f;
      const result = shiftByImmediate(rmValue, shiftType, amount, regs.cFlag);
      op2 = result.value;
      shifterC = result.carryOut;
    }
  }

  const rnValue = readReg(regs, rn, rnExtra);
  const result = alu(op, rnValue, op2, regs.cFlag, regs.vFlag, shifterC);

  // S=1 with Rd=PC on a data-processing op (any opcode, including
  // the comparison-class CMP / CMN / TST / TEQ) is the ARM7TDMI
  // "exception return" form: CPSR is replaced wholesale from the
  // current mode's SPSR. USR/SYS have no SPSR; we leave CPSR alone
  // there and fall through to a normal flag update so the test
  // ROMs don't get stuck on undefined behaviour.
  const exceptionReturn = setFlags && rd === 15 && regs.mode !== MODE_USR && regs.mode !== MODE_SYS;
  if (exceptionReturn) {
    const spsr = regs.spsr | 0;
    regs.setMode(spsr & 0x1f);
    regs.cpsr = spsr;
  }

  if (result.writes) {
    if (rd === 15) {
      // Align PC by the post-restore instruction width (T flag set
      // above when exceptionReturn fired). Without exception return,
      // ARM-state alignment is the only path that reaches here.
      regs.r[15] = regs.tFlag ? result.value & ~1 : result.value & ~3;
    } else {
      regs.r[rd] = result.value;
    }
  }

  // Skip the flag update when the SPSR-restore above already replaced
  // CPSR wholesale. Comparison-class ops with Rd=PC in a privileged
  // mode go through that path; in USR/SYS (no SPSR), they fall through
  // and update flags from the ALU result like any other compare.
  if (setFlags && !exceptionReturn) {
    regs.nFlag = result.flags.n;
    regs.zFlag = result.flags.z;
    regs.cFlag = result.flags.c;
    regs.vFlag = result.flags.v;
  }
}

/** LDR / STR / LDRB / STRB — class 0b010 (immediate offset) or
 *  0b011 (register-shifted offset). Implements:
 *    • the ARM7TDMI alignment-rotate quirk on unaligned word LDR
 *      (loaded word is rotated so the addressed byte lands at bits 7:0)
 *    • the PC+12 store quirk (STR Rd=R15 stores `instr_addr + 12`)
 *    • pre/post indexed, up/down, byte/word, optional writeback
 *  The T (user-mode access) variant — W bit set in a post-indexed
 *  encoding — is a privileged-mode hint used by OS code to access
 *  memory as if in user mode. The GBA has no MPU and the cart
 *  doesn't see a difference between SVC- and USR-mode accesses, so
 *  the T form behaves identically to a plain post-indexed access
 *  here. We honour the encoding without raising. */
function executeLoadStore(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isRegOffset = ((instr >>> 25) & 1) === 1;
  const preIndexed = ((instr >>> 24) & 1) === 1;
  const addOffset = ((instr >>> 23) & 1) === 1;
  const isByte = ((instr >>> 22) & 1) === 1;
  const wBit = ((instr >>> 21) & 1) === 1;
  const isLoad = ((instr >>> 20) & 1) === 1;
  const rn = (instr >>> 16) & 0xf;
  const rd = (instr >>> 12) & 0xf;

  // Offset computation. Note the polarity of bit 25 is inverted vs
  // data-processing: here 1 means register-form.
  let offset: number;
  if (isRegOffset) {
    // Register-form has bit 4 == 0. Bit 4 == 1 is the undefined slot
    // on ARMv4T (re-used as media instructions on ARMv6+). mgba-suite
    // probes this slot in io-read; real ARM7TDMI would raise an
    // undefined-instruction exception that the cart's UND vector
    // handler is expected to catch. We don't HLE the UND vector, so
    // the closest no-harm interpretation is a silent NOP.
    if (((instr >>> 4) & 1) !== 0) return;
    const shiftType = ((instr >>> 5) & 0x3) as ShiftType;
    const shiftAmount = (instr >>> 7) & 0x1f;
    const rm = instr & 0xf;
    // R15 as Rm is "unpredictable" per the ARM ARM but real ARM7TDMI
    // silicon just reads it as PC+8 like any other R15 read. Throwing
    // killed games that use this pattern (e.g. for PC-relative branch
    // tables); use the silicon behaviour instead.
    const rmValue = readReg(regs, rm, 4);
    offset = shiftByImmediate(rmValue, shiftType, shiftAmount, regs.cFlag).value;
  } else {
    offset = instr & 0xfff;
  }
  if (!addOffset) offset = -offset | 0;

  const baseValue = readReg(regs, rn, 4); // PC reads as PC+8
  const accessAddress = preIndexed ? (baseValue + offset) | 0 : baseValue;
  const updatedBase = preIndexed ? accessAddress : (baseValue + offset) | 0;
  // Post-indexed always writes back; pre-indexed only when W=1.
  const doWriteback = !preIndexed || wBit;

  if (isLoad) {
    let value: number;
    if (isByte) {
      value = bus.read8(accessAddress >>> 0);
    } else {
      // Word LDR: word at addr & ~3, rotated right by 8 × (addr & 3).
      // The RAW address goes on the bus — alignment happens there, and
      // the byte-bus SRAM region needs the low bits (see MappedBus).
      const rotate = (accessAddress & 3) * 8;
      const raw = bus.read32(accessAddress >>> 0) | 0;
      value = rotate === 0 ? raw : (raw >>> rotate) | (raw << (32 - rotate)) | 0;
    }
    // Writeback before the destination write, BUT skipped when
    // Rn === Rd (the load result takes precedence per the spec).
    if (doWriteback && rn !== rd) regs.r[rn] = updatedBase;
    if (rd === 15) {
      regs.r[15] = value & ~3;
    } else {
      regs.r[rd] = value;
    }
  } else {
    const storeValue = rd === 15 ? ((regs.r[15]! | 0) + 8) | 0 : regs.r[rd]! | 0;
    if (isByte) {
      bus.write8(accessAddress >>> 0, storeValue & 0xff);
    } else {
      // STR passes the unaligned address through to the bus. The bus
      // realigns for normal byte-region writes (EWRAM/IWRAM/etc.) but
      // cart-RAM handlers (SRAM/Flash) consume the address LSBs to
      // pick which byte of the word lands on the 8-bit data path.
      bus.write32(accessAddress >>> 0, storeValue);
    }
    if (doWriteback) regs.r[rn] = updatedBase;
  }
}

/** LDM / STM — class 0b100. Four addressing modes derived from the
 *  P (pre-index) and U (up) bits: IA / IB / DA / DB. Registers are
 *  always transferred in ascending order to ascending memory
 *  addresses; the mode only affects the start address and writeback
 *  value.
 *
 *  S-bit forms:
 *    • S=1, LDM, R15 in list → exception return. The transfer runs
 *      normally; afterwards CPSR is restored from the current mode's
 *      SPSR, which switches mode (and possibly ARM↔Thumb state).
 *    • S=1, LDM, R15 not in list → user-mode bank transfer. R8-R14
 *      use the USER-mode bank values regardless of current mode;
 *      writeback is not allowed.
 *    • S=1, STM → user-mode bank transfer (same as above for stores).
 *
 *  ARM7TDMI quirks that armwrestler probes (TRM §4.11.5 / §4.11.6):
 *    • Empty Rlist: only R15 is transferred; Rb advances by 0x40
 *      (= 16 × 4) regardless. ARMv5 dropped this; ARM7TDMI keeps it.
 *    • Rb in list + writeback: for STM, storing Rb yields the
 *      original Rb if Rb is the lowest register in the list,
 *      otherwise the post-writeback value (writeback happens during
 *      cycle 2, between the first store and the rest). For LDM the
 *      loaded value supersedes the writeback for Rb. */
function executeBlockTransfer(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const preIndexed = ((instr >>> 24) & 1) === 1;
  const incrementing = ((instr >>> 23) & 1) === 1;
  const sBit = ((instr >>> 22) & 1) === 1;
  const writeback = ((instr >>> 21) & 1) === 1;
  const isLoad = ((instr >>> 20) & 1) === 1;
  const rn = (instr >>> 16) & 0xf;
  const rlist = instr & 0xffff;

  // R15 as base in LDM/STM is "unpredictable" per the ARM spec, but
  // real ARM7TDMI silicon uses PC+8 as the address (the normal R15
  // read value) and proceeds. Released carts (Cabela's Big Game
  // Hunter, Mega Man Battle Network) ship instructions in this form.

  // ARM7TDMI empty-Rlist quirk: behave as if only R15 was specified,
  // but still adjust Rb by the full 0x40.
  const emptyList = rlist === 0;
  const effectiveList = emptyList ? 1 << 15 : rlist;
  let count = 0;
  for (let i = 0; i < 16; i++) if ((effectiveList & (1 << i)) !== 0) count++;
  const totalSize = emptyList ? 0x40 : count * 4;
  const r15InList = (effectiveList & (1 << 15)) !== 0;

  const isExceptionReturn = sBit && isLoad && r15InList;
  const isUserBankTransfer = sBit && !isExceptionReturn;
  // Call-stack tap: LDM loading PC is the canonical function-epilogue
  // pattern (`ldm sp!, {..., pc}` from a prologue push of {lr}+callee-
  // saves). Pop best-effort — incremental rare uses where PC is loaded
  // but the function is "actually a jump table" pop too.
  if (isLoad && r15InList) notePopGba();
  // S=1 user-bank transfer + writeback is "unpredictable" per the ARM
  // ARM, but ARM7TDMI silicon performs the user-bank transfer and
  // writes back to the CURRENT-mode Rb (baseValue was read before the
  // mode swap, so newBase reflects the current-mode register). The
  // `setMode(originalMode)` after the transfer ensures the writeback
  // below lands in the current bank. armwrestler relies on this.

  const baseValue = regs.r[rn]! | 0;

  let address: number;
  let newBase: number;
  if (incrementing) {
    address = preIndexed ? (baseValue + 4) | 0 : baseValue;
    newBase = (baseValue + totalSize) | 0;
  } else {
    address = preIndexed ? (baseValue - totalSize) | 0 : (baseValue - totalSize + 4) | 0;
    newBase = (baseValue - totalSize) | 0;
  }

  // STM with Rb in writeback list: figure out whether Rb's slot
  // gets the original or post-WB value. Only the *lowest* register
  // in the list goes out before writeback happens.
  const rnInList = (effectiveList & (1 << rn)) !== 0;
  let lowestInList = -1;
  for (let i = 0; i < 16; i++) {
    if ((effectiveList & (1 << i)) !== 0) {
      lowestInList = i;
      break;
    }
  }

  // For user-mode bank transfer outside USR/SYS, swap the register
  // file to the USER bank for the duration of the transfer so the
  // R8-R14 reads/writes hit the USER-banked values. ArmRegisters
  // takes care of saving the current banked state on the way out and
  // restoring it on the way back.
  const originalMode = regs.mode;
  const swapToUsr = isUserBankTransfer && originalMode !== MODE_USR && originalMode !== MODE_SYS;
  if (swapToUsr) regs.setMode(MODE_USR);

  // ARM7TDMI masks bit 0-1 of the LDM/STM access address internally,
  // even if the base register holds a misaligned value (which it can
  // legitimately do after pre-/post-increment from a misaligned
  // starting address). The base register itself keeps the unaligned
  // value across the transfer + writeback.
  if (isLoad) {
    for (let i = 0; i < 16; i++) {
      if ((effectiveList & (1 << i)) === 0) continue;
      const value = bus.read32(address >>> 0) | 0;
      if (i === 15) {
        // For exception return the alignment depends on the post-restore
        // T-bit, which we don't know yet — store raw and mask after the
        // CPSR restore below.
        regs.r[15] = isExceptionReturn ? value : value & ~3;
      } else {
        regs.r[i] = value;
      }
      address = (address + 4) | 0;
    }
  } else {
    for (let i = 0; i < 16; i++) {
      if ((effectiveList & (1 << i)) === 0) continue;
      let value: number;
      if (i === 15) {
        // STM with R15 in list stores PC+12 (= r[15] + 8 post-prefetch).
        value = ((regs.r[15]! | 0) + 8) | 0;
      } else if (i === rn && writeback && rn !== lowestInList) {
        // Rb is in the list but not first — its store reflects the
        // already-applied writeback.
        value = newBase;
      } else {
        value = regs.r[i]! | 0;
      }
      bus.write32(address >>> 0, value);
      address = (address + 4) | 0;
    }
  }

  if (swapToUsr) regs.setMode(originalMode);

  // Writeback. For LDM with Rb in list the loaded value wins, so
  // skip writeback entirely; otherwise update Rb. Targets the current
  // (pre-restore) mode's Rb in all cases — the exception-return mode
  // switch below runs only after this.
  if (writeback && !(isLoad && rnInList)) regs.r[rn] = newBase;

  if (isExceptionReturn) {
    const spsr = regs.spsr | 0;
    regs.setMode(spsr & 0x1f);
    regs.cpsr = spsr;
    // Align PC against the restored state's instruction width.
    regs.r[15] = regs.tFlag ? regs.r[15]! & ~1 : regs.r[15]! & ~3;
  }
}

/** Halfword + signed data transfer — class 0b000 with bits 7=1, 4=1,
 *  and (S, H) ≠ (0, 0). The (L, S, H) tuple selects the operation:
 *    (1, 0, 1)  LDRH    load unsigned halfword
 *    (0, 0, 1)  STRH    store halfword
 *    (1, 1, 0)  LDRSB   load signed byte
 *    (1, 1, 1)  LDRSH   load signed halfword
 *    L=0 with S=1 is reserved.
 *
 *  Offset is 8-bit immediate (high nibble in bits 11:8, low nibble in
 *  bits 3:0) or an unshifted Rm. Address quirks:
 *    • LDRH from a misaligned address (bit 0 set) loads the halfword
 *      at addr & ~1 and rotates it right by 8 — ARM7TDMI's "byte-swap
 *      on misaligned halfword" behaviour, exercised by armwrestler.
 *    • LDRSH from a misaligned address is UNPREDICTABLE per spec;
 *      this implementation treats it as LDRSB on the addressed byte —
 *      what real ARM7TDMI silicon actually does on a misaligned LDRSH.
 *    • STRH masks address bit 0 — the spec calls this UNPREDICTABLE,
 *      we just write at addr & ~1. */
function executeHalfwordTransfer(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const preIndexed = ((instr >>> 24) & 1) === 1;
  const addOffset = ((instr >>> 23) & 1) === 1;
  const immediateOffset = ((instr >>> 22) & 1) === 1;
  const wBit = ((instr >>> 21) & 1) === 1;
  const isLoad = ((instr >>> 20) & 1) === 1;
  const sBit = ((instr >>> 6) & 1) === 1;
  const hBit = ((instr >>> 5) & 1) === 1;
  const rn = (instr >>> 16) & 0xf;
  const rd = (instr >>> 12) & 0xf;

  // ARM7TDMI halfword/signed encodings with L=0 + S=1 (i.e. STRSB /
  // STRSH-shaped bits) are documented "unpredictable" on ARMv4T; the
  // slot became LDRD/STRD on ARMv5TE. mgba-suite probes these as
  // part of its memory-edge tests expecting the CPU not to crash.
  // Treat as a NOP — the safest interpretation of "unpredictable" on
  // hardware that doesn't implement the encoding. The cart's
  // condition check (already passed by the time we get here) is
  // still honoured, so the instruction simply has no observable effect.
  if (!isLoad && sBit) return;
  // Post-indexed halfword with W=1 is the user-mode access hint
  // (LDRHT / STRHT-shaped). Same reasoning as LDR/STR T-form: GBA
  // has no per-mode memory view so this behaves like plain
  // post-indexed. Fall through.

  let offset: number;
  if (immediateOffset) {
    offset = (((instr >>> 8) & 0xf) << 4) | (instr & 0xf);
  } else {
    // Bits 11:8 are SBZ in the register-offset form per the ARM7TDMI
    // spec. ARM calls non-zero values "unpredictable", but real
    // ARM7TDMI hardware (and Doom II's released cart) tolerates them
    // and uses bits 3:0 as Rm regardless — mask and proceed.
    const rm = instr & 0xf;
    // R15 as Rm reads PC+8 on real silicon (see LDR/STR comment above).
    offset = readReg(regs, rm, 4);
  }
  if (!addOffset) offset = -offset | 0;

  const baseValue = readReg(regs, rn, 4);
  const accessAddress = preIndexed ? (baseValue + offset) | 0 : baseValue;
  const updatedBase = preIndexed ? accessAddress : (baseValue + offset) | 0;
  const doWriteback = !preIndexed || wBit;

  if (isLoad) {
    let value: number;
    if (sBit && !hBit) {
      // LDRSB
      const byte = bus.read8(accessAddress >>> 0);
      value = (byte << 24) >> 24;
    } else if (!sBit && hBit) {
      // LDRH — ARM7TDMI's misaligned-halfword behaviour rotates the
      // zero-extended 32-bit value right by 8 bits when bit 0 of the
      // access address is set. The chip reads the aligned halfword,
      // zero-extends it into the 32-bit destination register, then
      // ROR-8s it (so a halfword 0x00CD read at an odd address ends
      // up as 0xCD000000 in the destination).
      const raw = bus.read16(accessAddress >>> 0) & 0xffff;
      value = (accessAddress & 1) !== 0 ? (raw >>> 8) | ((raw & 0xff) << 24) | 0 : raw;
    } else {
      // LDRSH
      if ((accessAddress & 1) !== 0) {
        // Misaligned LDRSH → treat as LDRSB on the addressed byte.
        const byte = bus.read8(accessAddress >>> 0);
        value = (byte << 24) >> 24;
      } else {
        const raw = bus.read16(accessAddress >>> 0) & 0xffff;
        value = (raw << 16) >> 16;
      }
    }
    if (doWriteback && rn !== rd) regs.r[rn] = updatedBase;
    if (rd === 15) {
      regs.r[15] = value & ~3;
    } else {
      regs.r[rd] = value;
    }
  } else {
    // STRH (the only valid !isLoad path, gated above by the S=0 check).
    // Pass the unaligned address through to the bus; the byte-region
    // path realigns, while cart-RAM handlers (SRAM/Flash) consume the
    // address LSB to pick which byte of the halfword reaches the chip.
    const storeValue = rd === 15 ? ((regs.r[15]! | 0) + 8) | 0 : regs.r[rd]! | 0;
    bus.write16(accessAddress >>> 0, storeValue & 0xffff);
    if (doWriteback) regs.r[rn] = updatedBase;
  }
}

/** Multiply — class 0b000 with bits 7:4 = 1001 and bit 24 = 0.
 *  Bit 23 selects short (32-bit MUL / MLA) vs long (64-bit
 *  UMULL / UMLAL / SMULL / SMLAL). For short multiplies the result
 *  is the low 32 bits of the product; for long multiplies the full
 *  64-bit product is split across RdHi (bits 19:16) and RdLo (bits
 *  15:12).
 *
 *  Long multiply uses BigInt because JS numbers lose integer
 *  precision above 2^53, and 32×32→64 products can reach 2^64−2^33+1.
 *  Short multiply uses Math.imul, which gives exact low-32-bit C-style
 *  integer multiplication and is significantly cheaper than BigInt.
 *
 *  ARM7TDMI flag quirks: when S=1, N and Z are set from the result.
 *  C and V are documented as UNPREDICTABLE on ARM7TDMI for both short
 *  and long multiplies; we leave them unchanged. */
/** ARM7TDMI booth-style multiply early-termination count.
 *  m = 1 if Rs[31:8]  is all 0 or all 1
 *  m = 2 if Rs[31:16] is all 0 or all 1
 *  m = 3 if Rs[31:24] is all 0 or all 1
 *  m = 4 otherwise. The signed and unsigned variants use the same
 *  formula — the booth recoder collapses runs of 0s OR 1s in either
 *  direction. Exported so the Thumb MUL path can use the same shape. */
export function multiplyMCycles(rs: number): number {
  const high24 = (rs >>> 8) & 0xffffff;
  if (high24 === 0 || high24 === 0xffffff) return 1;
  const high16 = (rs >>> 16) & 0xffff;
  if (high16 === 0 || high16 === 0xffff) return 2;
  const high8 = (rs >>> 24) & 0xff;
  if (high8 === 0 || high8 === 0xff) return 3;
  return 4;
}

/** ARM7TDMI long-multiply carry-flag model. The C flag after
 *  UMULL/SMULL/UMLAL/SMLAL is documented as "meaningless" by ARM,
 *  but real silicon sets it to a deterministic value falling out of
 *  the Booth multiplier — mgba-suite's multiply-long test checks it
 *  exactly. V is unaffected. `tickMultiplyFull` selects the Hi (full
 *  booth scan) vs Lo (early-terminated) carry path. All math is 32-bit;
 *  `Math.imul` + `| 0` / `>>> 0` reproduce C's u32 wraparound. */
function tickMultiplyFull(multiplier: number, isSigned: boolean): boolean {
  let mask = 0xffffff00;
  while (true) {
    multiplier = (multiplier & mask) >>> 0;
    if (multiplier === 0) break;
    if (isSigned && multiplier === mask >>> 0) break;
    mask = (mask << 8) >>> 0;
  }
  return mask === 0;
}

function multiplyCarryLo(multiplicand: number, multiplier: number, accum: number): number {
  multiplicand = (multiplicand | 1) >>> 0;
  let booth = (multiplier << 31) >> 31;
  let carry = Math.imul(multiplicand, booth) | 0;
  let sum = (carry + (accum | 0)) | 0;
  let shift = 29;
  do {
    for (let i = 0; i < 4; i++, shift -= 2) {
      const nextBooth = shift >= 0 ? (multiplier << shift) >> shift : multiplier | 0;
      const factor = (nextBooth - booth) | 0;
      booth = nextBooth | 0;
      const addend = Math.imul(multiplicand, factor) | 0;
      accum = (accum ^ carry ^ addend) | 0;
      sum = (sum + addend) | 0;
      carry = (sum - accum) | 0;
    }
  } while ((booth | 0) !== (multiplier | 0));
  return (carry >>> 31) & 1;
}

function multiplyCarryHi(multiplicand: number, multiplier: number, accumHi: number, signExtend: boolean): number {
  if (signExtend) {
    multiplicand = (multiplicand | 0) >> 6;
    multiplier = (multiplier | 0) >> 26;
  } else {
    multiplicand = multiplicand >>> 6;
    multiplier = multiplier >>> 26;
  }
  multiplicand = multiplicand | 1 | 0;
  const carry = (~accumHi & 0x20000000) | 0;
  let accum = (accumHi - 0x08000000) | 0;
  const booth0 = (multiplier << 27) >> 27;
  const booth1 = (multiplier << 29) >> 29;
  const booth2 = (multiplier << 31) >> 31;
  const factor0 = (multiplier - booth0) | 0;
  const factor1 = (booth0 - booth1) | 0;
  const factor2 = (booth1 - booth2) | 0;
  let addend = Math.imul(multiplicand, factor2) | 0;
  accum = (accum - (addend & 0x10000000)) | 0;
  addend = Math.imul(multiplicand, factor1) | 0;
  accum = (accum - (addend & 0x40000000)) | 0;
  let sum = (accum + (addend & 0x20000000)) | 0;
  accum = (accum - carry) | 0;
  addend = Math.imul(multiplicand, factor0) | 0;
  sum = (sum + (addend & 0x40000000)) | 0;
  return ((sum ^ accum) >>> 31) & 1;
}

function executeMultiply(regs: ArmRegisters, instr: number): void {
  const isLong = ((instr >>> 23) & 1) === 1;
  const setFlags = ((instr >>> 20) & 1) === 1;
  const rs = (instr >>> 8) & 0xf;
  const rm = instr & 0xf;
  // R15 in any multiply register is "unpredictable" per the ARM ARM,
  // but real ARM7TDMI silicon reads R15 as PC+8 for operands and
  // writes the result to PC for destinations (which our step loop
  // handles via pipeline invalidation). Throwing crashed real games
  // that emit this pattern, so emulate the silicon behaviour instead.
  const rmVal = readReg(regs, rm, 4);
  const rsVal = readReg(regs, rs, 4);

  if (isLong) {
    const isSigned = ((instr >>> 22) & 1) === 1;
    const accumulate = ((instr >>> 21) & 1) === 1;
    const rdHi = (instr >>> 16) & 0xf;
    const rdLo = (instr >>> 12) & 0xf;
    // RdHi == RdLo / R15 destinations are "unpredictable" per the ARM ARM;
    // silicon writes lo then hi, so the high half wins on collision and
    // writes to R15 cause a branch on the next step.

    // Capture the accumulator before the result overwrites RdHi/RdLo —
    // both the product and the carry model need the original values.
    const accumHi = accumulate ? regs.r[rdHi]! >>> 0 : 0;
    const accumLo = accumulate ? regs.r[rdLo]! >>> 0 : 0;
    const mask64 = (1n << 64n) - 1n;
    let product = isSigned ? BigInt(rmVal) * BigInt(rsVal) : BigInt(rmVal >>> 0) * BigInt(rsVal >>> 0);
    if (accumulate) {
      product = product + ((BigInt(accumHi) << 32n) | BigInt(accumLo));
    }
    product = product & mask64;
    const lo = Number(product & 0xffffffffn) | 0;
    const hi = Number((product >> 32n) & 0xffffffffn) | 0;
    regs.r[rdLo] = lo;
    regs.r[rdHi] = hi;
    if (setFlags) {
      regs.nFlag = ((hi >>> 31) & 1) !== 0;
      regs.zFlag = lo === 0 && hi === 0;
      // C = Booth-multiplier carry (V unaffected). See the carry helpers.
      const full = tickMultiplyFull(rsVal >>> 0, isSigned);
      const carry = full ? multiplyCarryHi(rmVal, rsVal, accumHi, isSigned) : multiplyCarryLo(rmVal, rsVal, accumLo);
      regs.cFlag = carry !== 0;
    }
  } else {
    const accumulate = ((instr >>> 21) & 1) === 1;
    const rd = (instr >>> 16) & 0xf;
    const rn = (instr >>> 12) & 0xf;
    let result = Math.imul(rmVal, rsVal) | 0;
    if (accumulate) {
      // R15 as the MLA accumulator reads PC+8 on silicon.
      result = (result + readReg(regs, rn, 4)) | 0;
    }
    // R15 as Rd is "unpredictable" per ARM ARM but silicon writes the
    // result to PC, causing a branch via the step loop's pipeline check.
    regs.r[rd] = result;
    if (setFlags) {
      regs.nFlag = result < 0;
      regs.zFlag = result === 0;
    }
  }
}

/** PSR transfer (MRS / MSR) — shares the TST/TEQ/CMP/CMN op-code
 *  slots with S=0. Bit 21 (the A bit in the data-processing view)
 *  selects MRS (0) vs MSR (1); bit 22 selects CPSR (0) vs SPSR (1).
 *  MSR has a register form (cls=000) and an immediate form (cls=001)
 *  distinguished by bit 25.
 *
 *  Field mask (bits 19:16): which bytes of the PSR are written. Bit
 *  19 = f (flags, bits 31:24), bit 18 = s (reserved on ARM7TDMI),
 *  bit 17 = x (reserved), bit 16 = c (control, bits 7:0). User mode
 *  can only modify the f field. Mode changes go through `setMode`
 *  so the banked-register swap fires correctly. */
function executePsrTransfer(regs: ArmRegisters, instr: number): void {
  const isMsr = ((instr >>> 21) & 1) === 1;
  const useSpsr = ((instr >>> 22) & 1) === 1;

  if (!isMsr) {
    const rd = (instr >>> 12) & 0xf;
    if (rd === 15) {
      throw new Error("R15 as destination in MRS is unpredictable");
    }
    regs.r[rd] = useSpsr ? regs.spsr : regs.cpsr;
    return;
  }

  // MSR
  const fieldMask = (instr >>> 16) & 0xf;
  const isImm = ((instr >>> 25) & 1) === 1;
  let value: number;
  if (isImm) {
    const rot = ((instr >>> 8) & 0xf) * 2;
    const imm = instr & 0xff;
    value = rot === 0 ? imm : (imm >>> rot) | (imm << (32 - rot)) | 0;
  } else {
    // R15 as Rm is "unpredictable" per the ARM spec; real ARM7TDMI
    // reads PC+8 like any other R15 read and writes it into the PSR.
    // Harvest Moon: Friends of Mineral Town's cart code relies on this.
    const rm = instr & 0xf;
    value = regs.r[rm]! | 0;
  }

  let writeMask = 0;
  if ((fieldMask & 0x1) !== 0) writeMask |= 0x000000ff; // c
  if ((fieldMask & 0x2) !== 0) writeMask |= 0x0000ff00; // x (reserved on ARM7TDMI)
  if ((fieldMask & 0x4) !== 0) writeMask |= 0x00ff0000; // s (reserved)
  if ((fieldMask & 0x8) !== 0) writeMask |= 0xff000000; // f

  if (useSpsr) {
    if (regs.mode === MODE_USR || regs.mode === MODE_SYS) {
      // No SPSR exists in USR / SYS — real ARM7TDMI silently drops
      // the write. BIOS code at 0x60 hits this path during boot
      // initialisation, so a throw kills runs with a loaded BIOS.
      return;
    }
    regs.spsr = (regs.spsr & ~writeMask) | (value & writeMask) | 0;
    return;
  }

  // CPSR write — user mode can only modify the f field.
  if (regs.mode === MODE_USR) writeMask &= 0xff000000;

  const newCpsr = (regs.cpsr & ~writeMask) | (value & writeMask) | 0;
  const newMode = newCpsr & 0x1f;
  if (newMode !== regs.mode) {
    regs.setMode(newMode);
  }
  regs.cpsr = newCpsr;
}

/** SWP / SWPB — atomic load-then-store. Bit 22 selects byte (1) vs
 *  word (0). The word form inherits the LDR alignment-rotate quirk
 *  for the read; the store writes at addr & ~3. */
function executeSwp(regs: ArmRegisters, bus: MemoryBus, instr: number): void {
  const isByte = ((instr >>> 22) & 1) === 1;
  const rn = (instr >>> 16) & 0xf;
  const rd = (instr >>> 12) & 0xf;
  const rm = instr & 0xf;
  // R15 in any SWP operand is "unpredictable" per the ARM spec; real
  // ARM7TDMI reads PC+8 for Rn/Rm and treats Rd=15 as a branch on the
  // load result. Bratz: Forever Diamondz emits an SWP with R15 in an
  // operand register; the released cart runs.
  const address = (regs.r[rn]! | 0) >>> 0;
  const sourceValue = regs.r[rm]! | 0;
  if (isByte) {
    const loaded = bus.read8(address);
    bus.write8(address, sourceValue & 0xff);
    regs.r[rd] = loaded;
  } else {
    const rotate = (address & 3) * 8;
    const raw = bus.read32(address >>> 0) | 0;
    const loaded = rotate === 0 ? raw : (raw >>> rotate) | (raw << (32 - rotate)) | 0;
    bus.write32(address >>> 0, sourceValue);
    regs.r[rd] = loaded;
  }
}

/** SWI — software interrupt. First attempts BIOS HLE for the calling
 *  function number (bits 23-16 of the instruction in ARM, 7-0 in
 *  Thumb). On a hit, we skip the SVC mode-switch entirely and the
 *  caller resumes at the next instruction. On a miss, we fall through
 *  to the standard ARM exception entry:
 *    1. SPSR_svc ← CPSR (current state)
 *    2. LR_svc   ← PC + 4 (= current r[15] after the prefetch advance)
 *    3. CPSR     ← SVC mode, IRQ masked, ARM state
 *    4. PC       ← 0x00000008 (SWI exception vector)
 *
 *  The exception vector lives in BIOS, which we don't ship — so an
 *  un-HLE'd SWI lands in zero-filled BIOS and silently NOP-slides.
 *  If a future ROM relies on an unimplemented BIOS routine, add it
 *  to the dispatcher in `bios-hle.ts`. */
function executeSwi(regs: ArmRegisters, bus: MemoryBus, instr: number, cpu?: ArmCpu): void {
  // With a real BIOS loaded the SWI handler at 0x08 runs naturally;
  // HLE is the fallback for no-BIOS builds.
  //
  // Exception: SWI 0x04 (IntrWait) and 0x05 (VBlankIntrWait) are
  // routed through HLE even with real BIOS. Real BIOS IntrWait uses
  // R4=1 across an inner loop that calls the user IRQ handler; carts
  // whose handlers don't preserve R4 (Space Invaders, SRT OG, etc.)
  // deadlock the real BIOS path because the clobbered R4 makes IME
  // stick at 0. Our HLE IntrWait doesn't rely on R4 and works for
  // both well-behaved and buggy handlers.
  if (cpu && cpu.interrupts) {
    const swiNumber = (instr >>> 16) & 0xff;
    if ((swiNumber === 0x04 || swiNumber === 0x05) && dispatchSwi(swiNumber, regs, bus, cpu, cpu.interrupts)) return;
  }
  if (cpu && cpu.interrupts && !cpu.hasBios) {
    const swiNumber = (instr >>> 16) & 0xff;
    if (dispatchSwi(swiNumber, regs, bus, cpu, cpu.interrupts)) return;
    // Unimplemented SWI in no-BIOS mode: silently skip the call.
    // Falling through to the real SVC exception entry below would set
    // PC=0x08 and — since the BIOS region is zero-filled — NOP-slide
    // up to PC=0x18 (BIOS IRQ vector), where `hleBiosIrqEntry` fires a
    // SPURIOUS IRQ entry that corrupts the IRQ stack and loops forever
    // (Dead to Rights hits this). Returning early leaves PC at the
    // post-SWI instruction so cart code continues with whatever
    // defaults the SWI's outputs would have produced.
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
