import { describe, expect, it } from "vitest";

import { FlatBus } from "../memory/bus.js";
import { ALU_ADC, ALU_ADD, ALU_AND, ALU_BIC, ALU_CMP, ALU_EOR, ALU_MOV, ALU_ORR, ALU_SUB, type AluOp } from "./alu.js";
import { COND_AL, COND_EQ, COND_NE } from "./conditions.js";
import { ArmCpu } from "./cpu.js";
import { MODE_SVC, MODE_USR } from "./registers.js";
import { SHIFT_LSL, SHIFT_LSR, type ShiftType } from "./shifter.js";

const I_BIT = 1 << 25;
const S_BIT = 1 << 20;

/** Build an immediate-operand data-processing instruction. */
function dpImm(cond: number, op: AluOp, s: boolean, rn: number, rd: number, rot: number, imm8: number): number {
  return (cond << 28) | I_BIT | (op << 21) | (s ? S_BIT : 0) | (rn << 16) | (rd << 12) | (rot << 8) | (imm8 & 0xff) | 0;
}

/** Build a register-operand data-processing instruction with an
 *  immediate shift amount (the common case for non-shifted register
 *  operands, with `shiftAmount = 0` for "no shift"). */
function dpReg(
  cond: number,
  op: AluOp,
  s: boolean,
  rn: number,
  rd: number,
  shiftAmount: number,
  shiftType: ShiftType,
  rm: number
): number {
  return (
    (cond << 28) |
    (op << 21) |
    (s ? S_BIT : 0) |
    (rn << 16) |
    (rd << 12) |
    ((shiftAmount & 0x1f) << 7) |
    (shiftType << 5) |
    (rm & 0xf) |
    0
  );
}

/** Build a register-operand data-processing instruction with a
 *  register-supplied shift amount (Rs). */
function dpRegByReg(
  cond: number,
  op: AluOp,
  s: boolean,
  rn: number,
  rd: number,
  rs: number,
  shiftType: ShiftType,
  rm: number
): number {
  return (
    (cond << 28) |
    (op << 21) |
    (s ? S_BIT : 0) |
    (rn << 16) |
    (rd << 12) |
    (rs << 8) |
    (shiftType << 5) |
    (1 << 4) |
    (rm & 0xf) |
    0
  );
}

function makeCpu(instructions: number[]): ArmCpu {
  const bus = new FlatBus(0x10000);
  for (let i = 0; i < instructions.length; i++) bus.write32(i * 4, instructions[i]!);
  return new ArmCpu(bus, 0);
}

describe("ARM data-processing — immediate operand", () => {
  it("MOV r0, #5", () => {
    const cpu = makeCpu([dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 5)]);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(5);
    expect(cpu.regs.r[15]).toBe(4);
  });

  it("MOV r1, #0xFF000000 via rotate", () => {
    // rotate=4 (×2=8) on imm8=0xFF gives 0xFF rotated right by 8 → 0xFF000000.
    // Actually rotate-right by 8 on 0xFF (which is in low byte) → bit 0–7
    // wrap to bit 24–31, yielding 0xFF000000.
    const cpu = makeCpu([dpImm(COND_AL, ALU_MOV, false, 0, 1, 4, 0xff)]);
    cpu.step();
    expect(cpu.regs.r[1]! >>> 0).toBe(0xff000000);
  });

  it("ADD r0, r0, #1 increments", () => {
    const cpu = makeCpu([dpImm(COND_AL, ALU_ADD, false, 0, 0, 0, 1)]);
    cpu.regs.r[0] = 0x41;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
  });

  it("SUB with S=1 sets Z when result is zero", () => {
    const cpu = makeCpu([dpImm(COND_AL, ALU_SUB, true, 0, 0, 0, 5)]);
    cpu.regs.r[0] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.zFlag).toBe(true);
    expect(cpu.regs.cFlag).toBe(true); // no borrow
  });
});

describe("ARM data-processing — register operand", () => {
  it("ADD r2, r0, r1 (no shift) sums register pair", () => {
    const cpu = makeCpu([dpReg(COND_AL, ALU_ADD, false, 0, 2, 0, SHIFT_LSL, 1)]);
    cpu.regs.r[0] = 10;
    cpu.regs.r[1] = 20;
    cpu.step();
    expect(cpu.regs.r[2]).toBe(30);
  });

  it("AND with EOR / ORR / BIC behave as documented", () => {
    const cpu = makeCpu([
      dpReg(COND_AL, ALU_AND, false, 0, 4, 0, SHIFT_LSL, 1),
      dpReg(COND_AL, ALU_EOR, false, 0, 5, 0, SHIFT_LSL, 1),
      dpReg(COND_AL, ALU_ORR, false, 0, 6, 0, SHIFT_LSL, 1),
      dpReg(COND_AL, ALU_BIC, false, 0, 7, 0, SHIFT_LSL, 1)
    ]);
    cpu.regs.r[0] = 0xf0f0f0f0 | 0;
    cpu.regs.r[1] = 0xff00ff00 | 0;
    cpu.step();
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.regs.r[4]! >>> 0).toBe(0xf000f000);
    expect(cpu.regs.r[5]! >>> 0).toBe(0x0ff00ff0);
    expect(cpu.regs.r[6]! >>> 0).toBe(0xfff0fff0);
    expect(cpu.regs.r[7]! >>> 0).toBe(0x00f000f0);
  });

  it("LSL #4 shift on the register operand", () => {
    const cpu = makeCpu([dpReg(COND_AL, ALU_MOV, false, 0, 0, 4, SHIFT_LSL, 1)]);
    cpu.regs.r[1] = 0x1;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x10);
  });

  it("LSR #16 shift exposes the upper half", () => {
    const cpu = makeCpu([dpReg(COND_AL, ALU_MOV, false, 0, 0, 16, SHIFT_LSR, 1)]);
    cpu.regs.r[1] = 0x12340000;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x1234);
  });

  it("shift-amount-in-register (LSL Rs)", () => {
    const cpu = makeCpu([dpRegByReg(COND_AL, ALU_MOV, false, 0, 0, 2, SHIFT_LSL, 1)]);
    cpu.regs.r[1] = 0x1;
    cpu.regs.r[2] = 4;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x10);
  });
});

describe("ARM data-processing — flag-only ops (TST/TEQ/CMP/CMN)", () => {
  it("CMP r0, r1 sets flags but doesn't write Rd", () => {
    const cpu = makeCpu([dpReg(COND_AL, ALU_CMP, true, 0, 5, 0, SHIFT_LSL, 1)]);
    cpu.regs.r[0] = 0x10;
    cpu.regs.r[1] = 0x10;
    const r5Before = cpu.regs.r[5];
    cpu.step();
    expect(cpu.regs.r[5]).toBe(r5Before);
    expect(cpu.regs.zFlag).toBe(true);
    expect(cpu.regs.cFlag).toBe(true);
  });

  it("CMP r0, r1 with r0 < r1 clears C (borrow) and sets N", () => {
    const cpu = makeCpu([dpReg(COND_AL, ALU_CMP, true, 0, 0, 0, SHIFT_LSL, 1)]);
    cpu.regs.r[0] = 0x05;
    cpu.regs.r[1] = 0x10;
    cpu.step();
    expect(cpu.regs.cFlag).toBe(false);
    expect(cpu.regs.nFlag).toBe(true);
    expect(cpu.regs.zFlag).toBe(false);
  });
});

describe("ARM conditional execution", () => {
  it("MOV{NE} r0, #1 is skipped when Z is set", () => {
    const cpu = makeCpu([dpImm(COND_NE, ALU_MOV, false, 0, 0, 0, 1)]);
    cpu.regs.zFlag = true;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.r[15]).toBe(4);
  });

  it("MOV{EQ} r0, #1 fires when Z is set", () => {
    const cpu = makeCpu([dpImm(COND_EQ, ALU_MOV, false, 0, 0, 0, 1)]);
    cpu.regs.zFlag = true;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(1);
  });
});

describe("ARM R15 quirks", () => {
  it("Rn=R15 reads as PC+8 when operand-2 is an immediate", () => {
    // MOV r0, pc — destination r0, source operand2 is r15 via MOV ignores rn
    // so we use ADD r0, r15, #0 to test Rn=15.
    const cpu = makeCpu([
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0), // nop spot at 0x00
      dpImm(COND_AL, ALU_ADD, false, 15, 0, 0, 0) // at 0x04: r0 := pc + 0
    ]);
    cpu.step(); // at 0x00 → r[15] becomes 4
    cpu.step(); // at 0x04 → r0 := (4 + 4) = 0x0C (because reads as PC+8 from instr@0x04)
    expect(cpu.regs.r[0]).toBe(0x0c);
  });

  it("writing to R15 branches", () => {
    // MOV pc, #16 — jump to 0x10 (offset, but we put dummy ROM there).
    // Since the immediate is rotated, rot=0/imm=16 gives a value of 16.
    const cpu = makeCpu([
      dpImm(COND_AL, ALU_MOV, false, 0, 15, 0, 16),
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 1), // 0x04: would set r0=1, but skipped
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 2), // 0x08: would set r0=2, but skipped
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 3), // 0x0C: would set r0=3, but skipped
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 9) // 0x10: r0 := 9
    ]);
    cpu.step(); // pc <- 16
    expect(cpu.regs.r[15]! >>> 0).toBe(0x10);
    cpu.step(); // pc=0x10, r0 := 9
    expect(cpu.regs.r[0]).toBe(9);
  });
});

describe("ARM coprocessor encodings are NOP'd, not thrown", () => {
  it("class 0b110 (LDC/STC) is silently NOP'd to match real ARM7TDMI", () => {
    // Real hardware raises an UND exception; we don't HLE the UND vector
    // and want cart code probing the coproc opcode space (mgba-suite-
    // memory does this) to keep running. Verify the CPU advances PC and
    // does not throw.
    const instr = (COND_AL << 28) | (0b110 << 25) | 0;
    const cpu = makeCpu([instr]);
    const pcBefore = cpu.regs.r[15]! >>> 0;
    expect(() => cpu.step()).not.toThrow();
    expect((cpu.regs.r[15]! >>> 0) - pcBefore).toBe(4);
  });
});

describe("ARM ADC handles the carry chain", () => {
  it("64-bit add via ADD low + ADC high", () => {
    // Compute (r0:r1) = (r2:r3) + (r4:r5), little-endian register pair.
    // Phase 1b ALU exercise — multi-instruction arithmetic.
    const cpu = makeCpu([
      dpReg(COND_AL, ALU_ADD, true, 2, 0, 0, SHIFT_LSL, 4), // r0 = r2 + r4, set flags
      dpReg(COND_AL, ALU_ADC, false, 3, 1, 0, SHIFT_LSL, 5) // r1 = r3 + r5 + C
    ]);
    cpu.regs.r[2] = 0xffffffff | 0;
    cpu.regs.r[3] = 0x00000001;
    cpu.regs.r[4] = 0x00000001;
    cpu.regs.r[5] = 0x00000002;
    cpu.step();
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.r[1]).toBe(4); // 1 + 2 + 1 (carry)
  });
});

/** Branch instruction: 24-bit signed offset × 4 from PC+8. */
function b(cond: number, fromAddr: number, toAddr: number, link = false): number {
  const offset = ((toAddr - fromAddr - 8) >> 2) & 0xffffff;
  return (cond << 28) | (0b101 << 25) | ((link ? 1 : 0) << 24) | offset | 0;
}

/** BX Rn — fixed bit pattern at 27:4, Rn in 3:0. */
function bx(cond: number, rn: number): number {
  return (cond << 28) | 0x012fff10 | (rn & 0xf) | 0;
}

describe("ARM B / BL", () => {
  it("B with positive offset jumps forward", () => {
    const program = [
      b(COND_AL, 0x00, 0x10),
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0xee), // skipped
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0xee), // skipped
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0xee), // skipped
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0x42) // 0x10: r0 := 0x42
    ];
    const cpu = makeCpu(program);
    cpu.step(); // branch to 0x10
    expect(cpu.regs.r[15]! >>> 0).toBe(0x10);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
  });

  it("B with negative offset loops backward", () => {
    // Loop body at 0x00 increments r0; trailing B at 0x04 branches back to 0x00.
    const program = [
      dpImm(COND_AL, ALU_ADD, false, 0, 0, 0, 1), // 0x00: r0 += 1
      b(COND_AL, 0x04, 0x00) // 0x04: B 0x00
    ];
    const cpu = makeCpu(program);
    for (let i = 0; i < 6; i++) {
      cpu.step(); // r0 += 1
      cpu.step(); // branch to 0x00
    }
    expect(cpu.regs.r[0]).toBe(6);
    expect(cpu.regs.r[15]).toBe(0);
  });

  it("BL writes the return address into LR and branches", () => {
    const program = [
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 1), // 0x00: r0 := 1
      b(COND_AL, 0x04, 0x10, true), // 0x04: BL 0x10
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0xee), // 0x08: skipped (post-BL)
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0xee), // 0x0C: skipped
      dpImm(COND_AL, ALU_MOV, false, 0, 1, 0, 2) // 0x10: r1 := 2
    ];
    const cpu = makeCpu(program);
    cpu.step(); // r0 := 1
    cpu.step(); // BL 0x10 — LR := 0x08
    expect(cpu.regs.r[14]).toBe(0x08);
    expect(cpu.regs.r[15]! >>> 0).toBe(0x10);
    cpu.step(); // r1 := 2
    expect(cpu.regs.r[1]).toBe(2);
  });

  it("BL chain — call site returns via MOV pc, lr", () => {
    // 0x00: BL 0x10   (LR := 0x04)
    // 0x04: MOV r2, #0xCC  ← post-call sentinel
    // 0x08, 0x0C: padding
    // 0x10: MOV r1, #0xAA  (function body)
    // 0x14: MOV pc, lr     (return)
    const program = [
      b(COND_AL, 0x00, 0x10, true),
      dpImm(COND_AL, ALU_MOV, false, 0, 2, 0, 0xcc),
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0),
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0),
      dpImm(COND_AL, ALU_MOV, false, 0, 1, 0, 0xaa),
      dpReg(COND_AL, ALU_MOV, false, 0, 15, 0, SHIFT_LSL, 14) // MOV pc, lr (Rm=lr=r14)
    ];
    const cpu = makeCpu(program);
    cpu.step(); // BL 0x10
    cpu.step(); // MOV r1, #0xAA
    cpu.step(); // MOV pc, lr → returns to 0x04
    expect(cpu.regs.r[15]! >>> 0).toBe(0x04);
    cpu.step(); // MOV r2, #0xCC
    expect(cpu.regs.r[1]).toBe(0xaa);
    expect(cpu.regs.r[2]).toBe(0xcc);
  });

  it("conditional B is skipped when the condition fails", () => {
    const program = [
      b(COND_EQ, 0x00, 0x10), // BEQ 0x10 — skipped when Z=0
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0x55)
    ];
    const cpu = makeCpu(program);
    cpu.regs.zFlag = false;
    cpu.step(); // BEQ skipped
    expect(cpu.regs.r[15]).toBe(4);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x55);
  });
});

describe("ARM BX", () => {
  it("BX to an even target stays in ARM state", () => {
    const cpu = makeCpu([bx(COND_AL, 1)]);
    cpu.regs.r[1] = 0x40;
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
    expect(cpu.regs.tFlag).toBe(false);
  });

  it("BX to an odd target switches to Thumb and masks bit 0", () => {
    const cpu = makeCpu([bx(COND_AL, 1)]);
    cpu.regs.r[1] = 0x40 | 1;
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
    expect(cpu.regs.tFlag).toBe(true);
  });
});

/** Build a LDR/STR/LDRB/STRB instruction. Either `immOffset` or
 *  `regOffset` is set, never both. */
function ldrstr(opts: {
  cond?: number;
  preIndex?: boolean;
  up?: boolean;
  byte?: boolean;
  writeback?: boolean;
  load: boolean;
  rn: number;
  rd: number;
  immOffset?: number;
  regOffset?: { rm: number; shiftType?: ShiftType; shiftAmount?: number };
}): number {
  const cond = opts.cond ?? COND_AL;
  const useReg = opts.regOffset !== undefined;
  const p = opts.preIndex ?? true;
  const u = opts.up ?? true;
  const offset = useReg
    ? ((opts.regOffset!.shiftAmount ?? 0) << 7) |
      ((opts.regOffset!.shiftType ?? SHIFT_LSL) << 5) |
      (opts.regOffset!.rm & 0xf)
    : (opts.immOffset ?? 0) & 0xfff;
  return (
    (cond << 28) |
    (0b010 << 25) |
    ((useReg ? 1 : 0) << 25) |
    ((p ? 1 : 0) << 24) |
    ((u ? 1 : 0) << 23) |
    ((opts.byte ? 1 : 0) << 22) |
    ((opts.writeback ? 1 : 0) << 21) |
    ((opts.load ? 1 : 0) << 20) |
    (opts.rn << 16) |
    (opts.rd << 12) |
    offset |
    0
  );
}

/** Build a LDM/STM instruction. `rlist` is the register-set bitmask
 *  (R0 = bit 0, R15 = bit 15). */
function ldmstm(opts: {
  cond?: number;
  preIndex?: boolean;
  up?: boolean;
  sBit?: boolean;
  writeback?: boolean;
  load: boolean;
  rn: number;
  rlist: number;
}): number {
  const cond = opts.cond ?? COND_AL;
  return (
    (cond << 28) |
    (0b100 << 25) |
    ((opts.preIndex ? 1 : 0) << 24) |
    ((opts.up ? 1 : 0) << 23) |
    ((opts.sBit ? 1 : 0) << 22) |
    ((opts.writeback ? 1 : 0) << 21) |
    ((opts.load ? 1 : 0) << 20) |
    (opts.rn << 16) |
    (opts.rlist & 0xffff) |
    0
  );
}

describe("ARM LDR / STR — word", () => {
  it("LDR rd, [rn, #imm] pre-indexed loads a word", () => {
    const cpu = makeCpu([ldrstr({ load: true, rn: 1, rd: 0, immOffset: 8 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0x108, 0xcafef00d | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xcafef00d);
    expect(cpu.regs.r[1]).toBe(0x100); // no writeback
  });

  it("LDR rd, [rn, #imm]! writes back the updated base", () => {
    const cpu = makeCpu([ldrstr({ load: true, rn: 1, rd: 0, immOffset: 4, writeback: true })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0x104, 0x11223344);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x11223344);
    expect(cpu.regs.r[1]).toBe(0x104);
  });

  it("LDR rd, [rn], #imm post-indexed always writes back", () => {
    const cpu = makeCpu([ldrstr({ load: true, rn: 1, rd: 0, immOffset: 8, preIndex: false })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0x100, 0xaabbccdd | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xaabbccdd);
    expect(cpu.regs.r[1]).toBe(0x108);
  });

  it("LDR with U=0 subtracts the offset", () => {
    const cpu = makeCpu([ldrstr({ load: true, rn: 1, rd: 0, immOffset: 4, up: false })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0xfc, 0xdeadbeef | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xdeadbeef);
  });

  it("STR rd, [rn, #imm] stores a word", () => {
    const cpu = makeCpu([ldrstr({ load: false, rn: 1, rd: 0, immOffset: 8 })]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[0] = 0x55aa55aa | 0;
    cpu.step();
    expect(cpu.bus.read32(0x108) >>> 0).toBe(0x55aa55aa);
  });

  it("STR with post-indexed writes to base address and increments", () => {
    const cpu = makeCpu([ldrstr({ load: false, rn: 1, rd: 0, immOffset: 4, preIndex: false })]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[0] = 0x12345678;
    cpu.step();
    expect(cpu.bus.read32(0x100) >>> 0).toBe(0x12345678);
    expect(cpu.regs.r[1]).toBe(0x104);
  });

  it("LDR with register offset shifted by #2", () => {
    const cpu = makeCpu([
      ldrstr({ load: true, rn: 1, rd: 0, regOffset: { rm: 2, shiftType: SHIFT_LSL, shiftAmount: 2 } })
    ]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 4; // shifted by 2 → 16 → addr 0x110
    cpu.bus.write32(0x110, 0x99);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x99);
  });
});

describe("ARM LDR alignment-rotate quirk", () => {
  it("LDR from an unaligned address rotates the word", () => {
    const cpu = makeCpu([ldrstr({ load: true, rn: 1, rd: 0, immOffset: 1 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0x100, 0x11223344);
    cpu.step();
    // Address 0x101 → rotate the word at 0x100 right by 8.
    expect(cpu.regs.r[0]! >>> 0).toBe(0x44112233);
  });

  it("LDR from addr with low bits 11 rotates by 24", () => {
    const cpu = makeCpu([ldrstr({ load: true, rn: 1, rd: 0, immOffset: 3 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0x100, 0x11223344);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0x22334411);
  });
});

describe("ARM LDRB / STRB — byte", () => {
  it("LDRB zero-extends an unsigned byte", () => {
    const cpu = makeCpu([ldrstr({ load: true, byte: true, rn: 1, rd: 0, immOffset: 2 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write8(0x102, 0xff);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xff);
  });

  it("STRB writes only the low byte", () => {
    const cpu = makeCpu([ldrstr({ load: false, byte: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[0] = 0x12345678;
    cpu.bus.write32(0x100, 0xffffffff | 0);
    cpu.step();
    expect(cpu.bus.read8(0x100)).toBe(0x78);
    // Other bytes unchanged.
    expect(cpu.bus.read8(0x101)).toBe(0xff);
  });
});

describe("ARM LDR Rd=R15 branches", () => {
  it("loading PC from memory transfers control", () => {
    const cpu = makeCpu([
      ldrstr({ load: true, rn: 1, rd: 15, immOffset: 0 }),
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 0xee) // skipped
    ]);
    cpu.regs.r[1] = 0x200;
    cpu.bus.write32(0x200, 0x40);
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
  });
});

describe("ARM LDM / STM — stack PUSH/POP", () => {
  it("STMDB sp!, {r0, r1, r2} then LDMIA sp!, {r3, r4, r5} round-trips", () => {
    // PUSH r0, r1, r2; then load them into r3, r4, r5.
    const program = [
      ldmstm({ load: false, preIndex: true, up: false, writeback: true, rn: 13, rlist: 0b0000_0000_0000_0111 }),
      ldmstm({ load: true, preIndex: false, up: true, writeback: true, rn: 13, rlist: 0b0000_0000_0011_1000 })
    ];
    const cpu = makeCpu(program);
    cpu.regs.r[13] = 0x1000;
    cpu.regs.r[0] = 0xa;
    cpu.regs.r[1] = 0xb;
    cpu.regs.r[2] = 0xc;
    cpu.step(); // STMDB
    expect(cpu.regs.r[13]).toBe(0x1000 - 12);
    // Verify ascending memory order: r0 at lowest address, r2 at highest.
    expect(cpu.bus.read32(0x1000 - 12)).toBe(0xa);
    expect(cpu.bus.read32(0x1000 - 8)).toBe(0xb);
    expect(cpu.bus.read32(0x1000 - 4)).toBe(0xc);
    cpu.step(); // LDMIA
    expect(cpu.regs.r[3]).toBe(0xa);
    expect(cpu.regs.r[4]).toBe(0xb);
    expect(cpu.regs.r[5]).toBe(0xc);
    expect(cpu.regs.r[13]).toBe(0x1000);
  });
});

describe("ARM LDM addressing modes", () => {
  it("LDMIA reads from base, base+4, … with writeback to base+count*4", () => {
    // rn=r0 (not in list); list = {r1, r2}.
    const cpu = makeCpu([
      ldmstm({ load: true, preIndex: false, up: true, writeback: true, rn: 0, rlist: 0b0000_0000_0000_0110 })
    ]);
    cpu.regs.r[0] = 0x100;
    cpu.bus.write32(0x100, 0x11);
    cpu.bus.write32(0x104, 0x22);
    cpu.step();
    expect(cpu.regs.r[1]).toBe(0x11);
    expect(cpu.regs.r[2]).toBe(0x22);
    expect(cpu.regs.r[0]).toBe(0x108); // base + 2 × 4
  });

  it("LDMIB reads from base+4 first, then +8…", () => {
    const cpu = makeCpu([ldmstm({ load: true, preIndex: true, up: true, rn: 1, rlist: 0b0000_0000_0000_0100 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0x104, 0xabcd);
    cpu.step();
    expect(cpu.regs.r[2]).toBe(0xabcd);
  });

  it("LDMDA reads downward (highest reg from base, then lower regs from lower addrs)", () => {
    // Register order is still low-to-high; address order is also
    // low-to-high. DA mode just shifts the starting address down.
    const cpu = makeCpu([ldmstm({ load: true, preIndex: false, up: false, rn: 1, rlist: 0b0000_0000_0000_0110 })]);
    cpu.regs.r[1] = 0x108;
    // start_addr = 0x108 - 8 + 4 = 0x104, then 0x108
    cpu.bus.write32(0x104, 0x11);
    cpu.bus.write32(0x108, 0x22);
    cpu.step();
    expect(cpu.regs.r[2]).toBe(0x22); // r2 at higher addr 0x108
    // r1 was overwritten by the load from 0x104 — that's spec-correct
    // since R1 itself was in the list with the base register.
    expect(cpu.regs.r[1]).toBe(0x11);
  });

  it("LDMDB reads from base-count*4 upward", () => {
    const cpu = makeCpu([ldmstm({ load: true, preIndex: true, up: false, rn: 1, rlist: 0b0000_0000_0000_0100 })]);
    cpu.regs.r[1] = 0x108;
    cpu.bus.write32(0x104, 0x77);
    cpu.step();
    expect(cpu.regs.r[2]).toBe(0x77);
  });
});

describe("ARM LDM Rd=R15 branches", () => {
  it("LDMIA with PC in list jumps to the loaded address", () => {
    const cpu = makeCpu([ldmstm({ load: true, preIndex: false, up: true, rn: 1, rlist: 0b1000_0000_0000_0000 })]);
    cpu.regs.r[1] = 0x200;
    cpu.bus.write32(0x200, 0x40);
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
  });
});

describe("ARM LDM S-bit forms", () => {
  it("exception return: LDM with R15 in list and S=1 restores CPSR from SPSR", () => {
    // SVC mode setup: SPSR_svc holds the pre-exception CPSR (USR mode).
    // Then LDMIA r1!, {pc}^ — exception-return form.
    const cpu = makeCpu([
      ldmstm({
        load: true,
        preIndex: false,
        up: true,
        sBit: true,
        writeback: false,
        rn: 1,
        rlist: 0b1000_0000_0000_0000
      })
    ]);
    cpu.regs.setMode(0x13); // SVC
    cpu.regs.spsr = 0x10; // SPSR_svc = USR mode, no flags
    cpu.regs.r[1] = 0x200;
    cpu.bus.write32(0x200, 0x40);
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
    // After the LDM, CPSR = SPSR → mode is now USR.
    expect(cpu.regs.mode).toBe(0x10);
    expect(cpu.regs.tFlag).toBe(false);
  });

  it("exception return masks PC to halfword alignment when SPSR.T is set", () => {
    const cpu = makeCpu([
      ldmstm({
        load: true,
        preIndex: false,
        up: true,
        sBit: true,
        rn: 1,
        rlist: 0b1000_0000_0000_0000
      })
    ]);
    cpu.regs.setMode(0x13);
    cpu.regs.spsr = 0x10 | 0x20; // USR + T bit
    cpu.regs.r[1] = 0x200;
    cpu.bus.write32(0x200, 0x41); // bit 0 set, masked to even for Thumb
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
    expect(cpu.regs.tFlag).toBe(true);
  });

  it("user-mode bank transfer: STM ^ writes user-bank R13 instead of current mode's R13", () => {
    // From SVC mode, STM ^ {r13} should read the USR-banked R13.
    const cpu = makeCpu([
      ldmstm({
        load: false,
        preIndex: true,
        up: false,
        sBit: true,
        rn: 0,
        rlist: 0b0010_0000_0000_0000 // R13
      })
    ]);
    // ArmRegisters defaults to SVC; populate USR's R13 explicitly.
    cpu.regs.setMode(0x10); // USR
    cpu.regs.r[13] = 0xaaaa_aaaa | 0;
    cpu.regs.setMode(0x13); // SVC
    cpu.regs.r[13] = 0xbbbb_bbbb | 0;
    cpu.regs.r[0] = 0x100;
    cpu.step();
    // Stored value should be the USR-bank R13 (0xAAAAAAAA), not SVC's.
    expect(cpu.bus.read32(0x100 - 4) >>> 0).toBe(0xaaaa_aaaa);
    // Current mode's R13 is unchanged.
    expect(cpu.regs.r[13]! >>> 0).toBe(0xbbbb_bbbb);
  });
});

describe("ARM LDM / STM — S=1 user-bank transfer with writeback (armwrestler probe)", () => {
  it("LDMIB r0!, {r3, lr}^ from SVC mode loads USR-bank LR and writes back to SVC-mode r0", () => {
    // 0xe9f04008 — the exact encoding armwrestler probes. S=1, writeback,
    // no R15 in list. Per ARM7TDMI: do the transfer in user bank, write
    // back to current-mode Rb.
    const cpu = makeCpu([
      ldmstm({ load: true, sBit: true, writeback: true, preIndex: true, up: true, rn: 0, rlist: 0b0100_0000_0000_1000 })
    ]);
    cpu.regs.setMode(0x13); // SVC
    cpu.regs.r[0] = 0x200;
    cpu.regs.r[14] = 0xbbbb_bbbb | 0; // SVC's LR, should be UNTOUCHED
    cpu.bus.write32(0x204, 0xdeadbeef | 0); // → r3
    cpu.bus.write32(0x208, 0xcafebabe | 0); // → USR-bank LR
    cpu.step();
    expect(cpu.regs.r[3]! >>> 0).toBe(0xdeadbeef);
    // SVC's r14 (LR) is unchanged — the load targeted the USR bank.
    expect(cpu.regs.r[14]! >>> 0).toBe(0xbbbb_bbbb);
    // Writeback to current-mode Rb (= SVC r0; r0 isn't banked so same
    // register either way).
    expect(cpu.regs.r[0]).toBe(0x208);
    // The transfer left SVC mode intact (no exception return — R15
    // wasn't in the list).
    expect(cpu.regs.cpsr & 0x1f).toBe(0x13);
    // Swap to USR to verify the load landed in the USR bank.
    cpu.regs.setMode(0x10);
    expect(cpu.regs.r[14]! >>> 0).toBe(0xcafebabe);
  });
});

describe("ARM LDM / STM — ARM7TDMI quirks (armwrestler probes)", () => {
  it("STM with Rb lowest in list + writeback stores the ORIGINAL Rb", () => {
    // STMIA r1!, {r1, r2} — r1 is the lowest in the list. Per TRM §4.11.6,
    // the first store happens before writeback, so we save the unchanged r1.
    const cpu = makeCpu([
      ldmstm({ load: false, preIndex: false, up: true, writeback: true, rn: 1, rlist: 0b0000_0000_0000_0110 })
    ]);
    cpu.regs.r[1] = 0x200;
    cpu.regs.r[2] = 0xc0ffee;
    cpu.step();
    expect(cpu.bus.read32(0x200) >>> 0).toBe(0x200); // original r1
    expect(cpu.bus.read32(0x204) >>> 0).toBe(0xc0ffee);
    expect(cpu.regs.r[1]).toBe(0x208); // writeback applied
  });

  it("STM with Rb NOT lowest in list + writeback stores the POST-WB Rb", () => {
    // STMIA r2!, {r0, r2} — r0 stores first (lowest), then writeback runs,
    // then r2 stores its already-updated value.
    const cpu = makeCpu([
      ldmstm({ load: false, preIndex: false, up: true, writeback: true, rn: 2, rlist: 0b0000_0000_0000_0101 })
    ]);
    cpu.regs.r[0] = 0xdeadbeef | 0;
    cpu.regs.r[2] = 0x300;
    cpu.step();
    expect(cpu.bus.read32(0x300) >>> 0).toBe(0xdeadbeef);
    expect(cpu.bus.read32(0x304) >>> 0).toBe(0x308); // post-WB r2
    expect(cpu.regs.r[2]).toBe(0x308);
  });

  it("LDM with Rb in list + writeback: the LOADED value wins (writeback suppressed)", () => {
    // LDMIA r1!, {r1, r2} — r1 is loaded from memory; writeback to r1 is
    // suppressed because the load already overwrote it.
    const cpu = makeCpu([
      ldmstm({ load: true, preIndex: false, up: true, writeback: true, rn: 1, rlist: 0b0000_0000_0000_0110 })
    ]);
    cpu.bus.write32(0x400, 0x12345678 | 0);
    cpu.bus.write32(0x404, 0x9abcdef0 | 0);
    cpu.regs.r[1] = 0x400;
    cpu.step();
    expect(cpu.regs.r[1]! >>> 0).toBe(0x12345678);
    expect(cpu.regs.r[2]! >>> 0).toBe(0x9abcdef0);
  });

  it("empty register list: only R15 is transferred, Rb adjusts by 0x40", () => {
    // STMIA r1!, {} — per TRM §4.11.5, only R15 stores (= PC + 12),
    // but writeback advances r1 by 0x40 as if all 16 had been stored.
    const cpu = makeCpu([ldmstm({ load: false, preIndex: false, up: true, writeback: true, rn: 1, rlist: 0 })]);
    cpu.regs.r[1] = 0x500;
    const pc = cpu.regs.r[15]! | 0;
    cpu.step();
    // STM with R15 in list stores PC + 12 (instruction address + 12).
    expect(cpu.bus.read32(0x500) >>> 0).toBe(((pc + 12) | 0) >>> 0);
    expect(cpu.regs.r[1]).toBe(0x500 + 0x40);
  });

  it("empty register list with LDMDB: loads PC from the bottom, Rb decrements by 0x40", () => {
    // LDMDB r1!, {} — pre-decrement. Address = r1 - 0x40, load PC from there.
    const cpu = makeCpu([ldmstm({ load: true, preIndex: true, up: false, writeback: true, rn: 1, rlist: 0 })]);
    cpu.regs.r[1] = 0x800;
    cpu.bus.write32(0x800 - 0x40, 0x08001020 | 0);
    cpu.step();
    expect(cpu.regs.r[1]).toBe(0x800 - 0x40);
    expect(cpu.regs.r[15]! >>> 0).toBe(0x08001020);
  });
});

/** Build a LDRH/STRH/LDRSB/LDRSH instruction. */
function halfword(opts: {
  cond?: number;
  preIndex?: boolean;
  up?: boolean;
  writeback?: boolean;
  load: boolean;
  signed: boolean;
  hword: boolean;
  rn: number;
  rd: number;
  immOffset?: number;
  rm?: number;
}): number {
  const cond = opts.cond ?? COND_AL;
  const p = opts.preIndex ?? true;
  const u = opts.up ?? true;
  const isImm = opts.immOffset !== undefined;
  const offset = isImm ? (opts.immOffset ?? 0) & 0xff : 0;
  const offsetHi = isImm ? (offset >>> 4) & 0xf : 0;
  const offsetLo = isImm ? offset & 0xf : (opts.rm ?? 0) & 0xf;
  return (
    (cond << 28) |
    ((p ? 1 : 0) << 24) |
    ((u ? 1 : 0) << 23) |
    ((isImm ? 1 : 0) << 22) |
    ((opts.writeback ? 1 : 0) << 21) |
    ((opts.load ? 1 : 0) << 20) |
    (opts.rn << 16) |
    (opts.rd << 12) |
    (offsetHi << 8) |
    (1 << 7) |
    ((opts.signed ? 1 : 0) << 6) |
    ((opts.hword ? 1 : 0) << 5) |
    (1 << 4) |
    offsetLo |
    0
  );
}

describe("ARM LDRH / STRH — unsigned halfword", () => {
  it("LDRH reads a halfword and zero-extends", () => {
    const cpu = makeCpu([halfword({ load: true, signed: false, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x100, 0xabcd);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xabcd);
  });

  it("LDRH from a misaligned address (bit 0 set) rotates by 8", () => {
    const cpu = makeCpu([halfword({ load: true, signed: false, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x101;
    cpu.bus.write16(0x100, 0xabcd);
    cpu.step();
    // ARM7TDMI misaligned-halfword behaviour: the chip reads the
    // aligned halfword (0xABCD), zero-extends into the 32-bit
    // destination (0x0000ABCD), then ROR-8s — so the low byte rotates
    // up into the high byte.
    expect(cpu.regs.r[0]! >>> 0).toBe(0xcd0000ab);
  });

  it("STRH writes a halfword (high bits of Rd ignored)", () => {
    const cpu = makeCpu([halfword({ load: false, signed: false, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[0] = 0xfeed1234 | 0;
    cpu.bus.write16(0x100, 0xffff);
    cpu.step();
    expect(cpu.bus.read16(0x100)).toBe(0x1234);
  });

  it("STRH passes the unaligned address through to the bus (the bus realigns / picks bytes)", () => {
    // The cart-RAM data path (SRAM/Flash) is 8-bit-wide and needs the
    // address LSB to decide which half of the halfword reaches the
    // chip. The CPU therefore no longer masks bit 0 — it passes the
    // unaligned address through and lets the bus / handler decide.
    // FlatBus (this test fixture) doesn't realign, so a halfword
    // store at 0x101 lands raw at 0x101 / 0x102.
    const cpu = makeCpu([halfword({ load: false, signed: false, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x101;
    cpu.regs.r[0] = 0xbeef;
    cpu.step();
    expect(cpu.bus.read8(0x101)).toBe(0xef);
    expect(cpu.bus.read8(0x102)).toBe(0xbe);
  });
});

describe("ARM LDRSB — signed byte", () => {
  it("loads a positive byte without sign extension", () => {
    const cpu = makeCpu([halfword({ load: true, signed: true, hword: false, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write8(0x100, 0x42);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
  });

  it("sign-extends a negative byte to 32 bits", () => {
    const cpu = makeCpu([halfword({ load: true, signed: true, hword: false, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write8(0x100, 0xff);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(-1);
  });
});

describe("ARM LDRSH — signed halfword", () => {
  it("loads a positive halfword without sign extension", () => {
    const cpu = makeCpu([halfword({ load: true, signed: true, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x100, 0x1234);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x1234);
  });

  it("sign-extends a negative halfword to 32 bits", () => {
    const cpu = makeCpu([halfword({ load: true, signed: true, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x100, 0xffff);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(-1);
  });

  it("misaligned LDRSH is treated as LDRSB on the addressed byte", () => {
    const cpu = makeCpu([halfword({ load: true, signed: true, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[1] = 0x101;
    cpu.bus.write8(0x101, 0xfe);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(-2);
  });
});

describe("ARM halfword transfer — addressing forms", () => {
  it("immediate offset spans both nibbles (bits 11:8 high, 3:0 low)", () => {
    // Offset 0xAA: high nibble (0xA) goes in bits 11:8, low (0xA) in
    // bits 3:0. Use an even offset to avoid the misaligned-LDRH
    // rotate quirk, which has its own dedicated test above.
    const cpu = makeCpu([halfword({ load: true, signed: false, hword: true, rn: 1, rd: 0, immOffset: 0xaa })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x100 + 0xaa, 0xbeef);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xbeef);
  });

  it("register offset (unshifted Rm)", () => {
    const cpu = makeCpu([halfword({ load: true, signed: false, hword: true, rn: 1, rd: 0, rm: 2 })]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0x10;
    cpu.bus.write16(0x110, 0x1234);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x1234);
  });

  it("negative offset (U=0) subtracts from base", () => {
    const cpu = makeCpu([halfword({ load: true, signed: false, hword: true, rn: 1, rd: 0, immOffset: 4, up: false })]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x0fc, 0xbabe);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xbabe);
  });

  it("pre-indexed writeback updates Rn after computing access addr", () => {
    const cpu = makeCpu([
      halfword({ load: true, signed: false, hword: true, rn: 1, rd: 0, immOffset: 8, writeback: true })
    ]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x108, 0xdead);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xdead);
    expect(cpu.regs.r[1]).toBe(0x108);
  });

  it("post-indexed always writes back the updated base", () => {
    const cpu = makeCpu([
      halfword({ load: true, signed: false, hword: true, rn: 1, rd: 0, immOffset: 4, preIndex: false })
    ]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x100, 0x99);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x99);
    expect(cpu.regs.r[1]).toBe(0x104);
  });
});

describe("ARM halfword transfer — reserved encodings (NOP'd)", () => {
  it("L=0 with S=1 NOPs cleanly (ARMv4T unpredictable; mgba-suite probes it)", () => {
    // The L=0/S=1 slot has no defined behaviour on ARMv4T (became
    // LDRD/STRD on ARMv5TE). mgba-suite-dma probes the encoding to
    // verify the emulator doesn't crash on it — we NOP without
    // touching memory or registers so the probe passes through.
    const cpu = makeCpu([halfword({ load: false, signed: true, hword: true, rn: 1, rd: 0, immOffset: 0 })]);
    cpu.regs.r[0] = 0xdeadbeef | 0;
    cpu.regs.r[1] = 0x1000;
    expect(() => cpu.step()).not.toThrow();
    // No memory write happened (we didn't mutate the bus byte at r1).
    expect(cpu.bus.read32(0x1000)).toBe(0);
    // No register state mutated.
    expect(cpu.regs.r[0] >>> 0).toBe(0xdeadbeef);
    expect(cpu.regs.r[1]).toBe(0x1000);
  });
});

/** Build a MUL / MLA instruction. */
function mul(opts: {
  cond?: number;
  accumulate?: boolean;
  setFlags?: boolean;
  rd: number;
  rn?: number;
  rs: number;
  rm: number;
}): number {
  const cond = opts.cond ?? COND_AL;
  return (
    (cond << 28) |
    ((opts.accumulate ? 1 : 0) << 21) |
    ((opts.setFlags ? 1 : 0) << 20) |
    (opts.rd << 16) |
    ((opts.rn ?? 0) << 12) |
    (opts.rs << 8) |
    (0b1001 << 4) |
    (opts.rm & 0xf) |
    0
  );
}

/** Build a UMULL / UMLAL / SMULL / SMLAL instruction. */
function mull(opts: {
  cond?: number;
  signed?: boolean;
  accumulate?: boolean;
  setFlags?: boolean;
  rdHi: number;
  rdLo: number;
  rs: number;
  rm: number;
}): number {
  const cond = opts.cond ?? COND_AL;
  return (
    (cond << 28) |
    (0b00001 << 23) |
    ((opts.signed ? 1 : 0) << 22) |
    ((opts.accumulate ? 1 : 0) << 21) |
    ((opts.setFlags ? 1 : 0) << 20) |
    (opts.rdHi << 16) |
    (opts.rdLo << 12) |
    (opts.rs << 8) |
    (0b1001 << 4) |
    (opts.rm & 0xf) |
    0
  );
}

describe("ARM MUL / MLA — 32-bit multiply", () => {
  it("MUL r0, r1, r2 multiplies into r0", () => {
    const cpu = makeCpu([mul({ rd: 0, rs: 2, rm: 1 })]);
    cpu.regs.r[1] = 7;
    cpu.regs.r[2] = 6;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(42);
  });

  it("MUL keeps only the low 32 bits when the product would overflow", () => {
    const cpu = makeCpu([mul({ rd: 0, rs: 2, rm: 1 })]);
    cpu.regs.r[1] = 0x10000;
    cpu.regs.r[2] = 0x10000;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
  });

  it("MULS sets N and Z from the result", () => {
    const cpu = makeCpu([mul({ rd: 0, rs: 2, rm: 1, setFlags: true })]);
    cpu.regs.r[1] = 0;
    cpu.regs.r[2] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.zFlag).toBe(true);
    expect(cpu.regs.nFlag).toBe(false);
  });

  it("MLA r0, r1, r2, r3 computes (r1 * r2) + r3", () => {
    const cpu = makeCpu([mul({ rd: 0, rs: 2, rm: 1, rn: 3, accumulate: true })]);
    cpu.regs.r[1] = 3;
    cpu.regs.r[2] = 4;
    cpu.regs.r[3] = 100;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(112);
  });

  it("MUL with negative operands produces the correct low-32-bit signed result", () => {
    const cpu = makeCpu([mul({ rd: 0, rs: 2, rm: 1 })]);
    cpu.regs.r[1] = -1;
    cpu.regs.r[2] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(-5);
  });

  it("R15 as MUL destination writes the product to PC (silicon behaviour, not a throw)", () => {
    const cpu = makeCpu([mul({ rd: 15, rs: 2, rm: 1 })]);
    cpu.regs.r[1] = 7;
    cpu.regs.r[2] = 6;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(42);
  });
});

describe("ARM UMULL — unsigned 64-bit multiply", () => {
  it("UMULL rdLo=r0, rdHi=r1, r2*r3", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2 })]);
    cpu.regs.r[2] = 0x10000;
    cpu.regs.r[3] = 0x10000;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.r[1]).toBe(1);
  });

  it("UMULL treats operands as unsigned (0xFFFFFFFF * 1 → low 32 bits = 0xFFFFFFFF, high = 0)", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2 })]);
    cpu.regs.r[2] = 0xffffffff | 0;
    cpu.regs.r[3] = 1;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xffffffff);
    expect(cpu.regs.r[1]).toBe(0);
  });

  it("UMULLS sets Z when the full 64-bit result is zero", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2, setFlags: true })]);
    cpu.regs.r[2] = 0;
    cpu.regs.r[3] = 0xdeadbeef | 0;
    cpu.step();
    expect(cpu.regs.zFlag).toBe(true);
  });
});

describe("ARM SMULL — signed 64-bit multiply", () => {
  it("SMULL of two negatives gives a positive 64-bit product", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2, signed: true })]);
    cpu.regs.r[2] = -2;
    cpu.regs.r[3] = -3;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(6);
    expect(cpu.regs.r[1]).toBe(0);
  });

  it("SMULL of negative × positive gives a negative 64-bit product", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2, signed: true })]);
    cpu.regs.r[2] = -1;
    cpu.regs.r[3] = 1;
    cpu.step();
    // Result is -1, sign-extended to 64 bits → 0xFFFFFFFF_FFFFFFFF
    expect(cpu.regs.r[0]! >>> 0).toBe(0xffffffff);
    expect(cpu.regs.r[1]! >>> 0).toBe(0xffffffff);
  });

  it("SMULLS sets N when the 64-bit result is negative", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2, signed: true, setFlags: true })]);
    cpu.regs.r[2] = -1;
    cpu.regs.r[3] = 1;
    cpu.step();
    expect(cpu.regs.nFlag).toBe(true);
    expect(cpu.regs.zFlag).toBe(false);
  });
});

describe("ARM UMLAL / SMLAL — accumulating 64-bit multiply", () => {
  it("UMLAL adds the existing RdHi:RdLo accumulator to the product", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2, accumulate: true })]);
    cpu.regs.r[2] = 0x10000;
    cpu.regs.r[3] = 0x10000; // product = 0x1_00000000
    cpu.regs.r[0] = 0x42; // existing low accumulator
    cpu.regs.r[1] = 0x10; // existing high accumulator
    cpu.step();
    // (0x10 << 32 | 0x42) + 0x1_0000_0000 = 0x11 << 32 | 0x42
    expect(cpu.regs.r[0]).toBe(0x42);
    expect(cpu.regs.r[1]).toBe(0x11);
  });

  it("SMLAL works with a negative product offset by a positive accumulator", () => {
    const cpu = makeCpu([mull({ rdHi: 1, rdLo: 0, rs: 3, rm: 2, signed: true, accumulate: true })]);
    cpu.regs.r[2] = -1;
    cpu.regs.r[3] = 5; // product = -5, two's-complement 64-bit = 0xFFFFFFFF_FFFFFFFB
    cpu.regs.r[0] = 10; // accumulator low
    cpu.regs.r[1] = 0; // accumulator high
    cpu.step();
    // -5 + 10 = 5, sign-extended high = 0
    expect(cpu.regs.r[0]).toBe(5);
    expect(cpu.regs.r[1]).toBe(0);
  });
});

describe("ARM long multiply silicon behaviour for 'unpredictable' inputs", () => {
  it("RdHi == RdLo: silicon writes lo first then hi, so high half wins", () => {
    const cpu = makeCpu([mull({ rdHi: 0, rdLo: 0, rs: 3, rm: 2 })]);
    cpu.regs.r[2] = 0x10000;
    cpu.regs.r[3] = 0x10000; // product = 0x1_0000_0000 → lo=0, hi=1
    cpu.step();
    expect(cpu.regs.r[0]).toBe(1);
  });

  it("R15 as RdHi writes the high half to PC instead of throwing", () => {
    const cpu = makeCpu([mull({ rdHi: 15, rdLo: 0, rs: 3, rm: 2 })]);
    cpu.regs.r[2] = 0x10000;
    cpu.regs.r[3] = 0x10000;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(1);
  });
});

/** Build a MRS instruction. */
function mrs(opts: { cond?: number; useSpsr?: boolean; rd: number }): number {
  const cond = opts.cond ?? COND_AL;
  return (cond << 28) | (0b00010 << 23) | ((opts.useSpsr ? 1 : 0) << 22) | (0b1111 << 16) | (opts.rd << 12) | 0;
}

/** Build a MSR (register-form) instruction. */
function msrReg(opts: { cond?: number; useSpsr?: boolean; fieldMask: number; rm: number }): number {
  const cond = opts.cond ?? COND_AL;
  return (
    (cond << 28) |
    (0b00010 << 23) |
    ((opts.useSpsr ? 1 : 0) << 22) |
    (0b10 << 20) |
    ((opts.fieldMask & 0xf) << 16) |
    (0b1111 << 12) |
    (opts.rm & 0xf) |
    0
  );
}

/** Build a MSR (immediate-form) instruction. */
function msrImm(opts: { cond?: number; useSpsr?: boolean; fieldMask: number; rot?: number; imm8: number }): number {
  const cond = opts.cond ?? COND_AL;
  return (
    (cond << 28) |
    (0b001 << 25) |
    (0b10 << 23) |
    ((opts.useSpsr ? 1 : 0) << 22) |
    (0b10 << 20) |
    ((opts.fieldMask & 0xf) << 16) |
    (0b1111 << 12) |
    (((opts.rot ?? 0) & 0xf) << 8) |
    (opts.imm8 & 0xff) |
    0
  );
}

/** Build a SWP / SWPB instruction. */
function swp(opts: { cond?: number; byte?: boolean; rn: number; rd: number; rm: number }): number {
  const cond = opts.cond ?? COND_AL;
  return (
    (cond << 28) |
    (0b00010 << 23) |
    ((opts.byte ? 1 : 0) << 22) |
    (opts.rn << 16) |
    (opts.rd << 12) |
    (0b1001 << 4) |
    (opts.rm & 0xf) |
    0
  );
}

/** Build a SWI instruction. */
function swi(opts: { cond?: number; comment?: number }): number {
  const cond = opts.cond ?? COND_AL;
  return (cond << 28) | (0b1111 << 24) | ((opts.comment ?? 0) & 0xffffff) | 0;
}

describe("ARM MRS — read PSR", () => {
  it("MRS r0, CPSR reads the current CPSR", () => {
    const cpu = makeCpu([mrs({ rd: 0 })]);
    cpu.regs.zFlag = true;
    cpu.regs.cFlag = true;
    const expected = cpu.regs.cpsr;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(expected);
  });

  it("MRS r0, SPSR reads the SPSR of the current privileged mode", () => {
    const cpu = makeCpu([mrs({ rd: 0, useSpsr: true })]);
    // Default mode is SVC, which has an SPSR.
    cpu.regs.spsr = 0x600000d3 | 0;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0x600000d3);
  });
});

describe("ARM MSR — write PSR", () => {
  it("MSR CPSR_f, r0 writes only the flag bits", () => {
    const cpu = makeCpu([msrReg({ fieldMask: 0x8, rm: 0 })]);
    cpu.regs.r[0] = 0xf0000000 | 0; // N=Z=C=V=1
    const before = cpu.regs.cpsr;
    cpu.step();
    // Top byte should be 0xF0; rest unchanged.
    expect(cpu.regs.cpsr & 0xff000000).toBe(0xf0000000 | 0);
    expect(cpu.regs.cpsr & 0x00ffffff).toBe(before & 0x00ffffff);
  });

  it("MSR CPSR_c (privileged) writes the control byte and triggers mode switch", () => {
    // SVC starts; switch to FIQ via field-mask c (bit 16).
    const cpu = makeCpu([msrReg({ fieldMask: 0x1, rm: 0 })]);
    cpu.regs.r[0] = 0x000000d1 | 0; // mode=0x11 (FIQ), I=F=1
    cpu.step();
    expect(cpu.regs.mode).toBe(0x11);
  });

  it("MSR CPSR via immediate form (flags only)", () => {
    // imm8=0xF0 with rot=0 → value 0xF0; rot=4 → 0xF000_0000 (rot*2=8 bits).
    const cpu = makeCpu([msrImm({ fieldMask: 0x8, rot: 4, imm8: 0xf0 })]);
    cpu.step();
    expect(cpu.regs.cpsr & 0xff000000).toBe(0xf0000000 | 0);
  });

  it("MSR in user mode cannot change mode bits, only flags", () => {
    const cpu = makeCpu([msrReg({ fieldMask: 0xf, rm: 0 })]);
    cpu.regs.setMode(MODE_USR);
    cpu.regs.r[0] = 0xf000_00d1 | 0; // would set flags AND mode=FIQ
    cpu.step();
    expect(cpu.regs.mode).toBe(MODE_USR);
    expect(cpu.regs.cpsr & 0xff000000).toBe(0xf0000000 | 0);
  });

  it("MSR to SPSR in user mode is silently dropped (no SPSR exists)", () => {
    // Real ARM7TDMI ignores writes when SPSR isn't banked in. The
    // Nintendo BIOS does this during boot at 0x60 — throwing was
    // killing real-BIOS runs.
    const cpu = makeCpu([msrReg({ useSpsr: true, fieldMask: 0xf, rm: 0 })]);
    cpu.regs.setMode(MODE_USR);
    cpu.regs.r[0] = 0xdeadbeef;
    const pcBefore = cpu.regs.r[15]! >>> 0;
    expect(() => cpu.step()).not.toThrow();
    expect((cpu.regs.r[15]! >>> 0) - pcBefore).toBe(4);
  });
});

describe("ARM SWP — atomic swap", () => {
  it("SWP word: r0 := mem[r2]; mem[r2] := r1 (round-trip)", () => {
    const cpu = makeCpu([swp({ rn: 2, rd: 0, rm: 1 })]);
    cpu.regs.r[2] = 0x200;
    cpu.regs.r[1] = 0x12345678;
    cpu.bus.write32(0x200, 0xcafef00d | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xcafef00d);
    expect(cpu.bus.read32(0x200)).toBe(0x12345678);
  });

  it("SWPB byte: zero-extends loaded byte, stores only low byte", () => {
    const cpu = makeCpu([swp({ byte: true, rn: 2, rd: 0, rm: 1 })]);
    cpu.regs.r[2] = 0x200;
    cpu.regs.r[1] = 0x12345678;
    cpu.bus.write8(0x200, 0xab);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xab);
    expect(cpu.bus.read8(0x200)).toBe(0x78);
  });

  it("SWP word with same Rd and Rm swaps the register with memory", () => {
    const cpu = makeCpu([swp({ rn: 2, rd: 0, rm: 0 })]);
    cpu.regs.r[2] = 0x200;
    cpu.regs.r[0] = 0x42;
    cpu.bus.write32(0x200, 0x99);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x99);
    expect(cpu.bus.read32(0x200)).toBe(0x42);
  });

  it("SWP word inherits the LDR alignment-rotate quirk on unaligned reads", () => {
    const cpu = makeCpu([swp({ rn: 2, rd: 0, rm: 1 })]);
    cpu.regs.r[2] = 0x201;
    cpu.regs.r[1] = 0;
    cpu.bus.write32(0x200, 0x11223344);
    cpu.step();
    // Address 0x201 → rotate by 8.
    expect(cpu.regs.r[0]! >>> 0).toBe(0x44112233);
  });
});

describe("ARM SWI — software interrupt", () => {
  it("triggers the SVC exception entry sequence", () => {
    const cpu = makeCpu([swi({ comment: 0x42 })]);
    // Force a non-SVC starting mode + known flags so we can see SPSR_svc and bank swap.
    cpu.regs.setMode(MODE_USR);
    cpu.regs.zFlag = true;
    const expectedSpsr = cpu.regs.cpsr;
    cpu.step();
    expect(cpu.regs.mode).toBe(MODE_SVC);
    expect(cpu.regs.iFlag).toBe(true);
    expect(cpu.regs.tFlag).toBe(false);
    expect(cpu.regs.r[15]).toBe(0x08);
    expect(cpu.regs.r[14]).toBe(0x04); // return address = instr + 4
    expect(cpu.regs.spsr).toBe(expectedSpsr);
  });
});
