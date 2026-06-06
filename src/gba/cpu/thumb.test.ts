import { describe, expect, it } from "vitest";

import { FlatBus } from "../memory/bus.js";
import { ArmCpu } from "./cpu.js";
import { CPSR_C, CPSR_T, CPSR_V } from "./registers.js";

type ShiftOp = 0 | 1 | 2; // LSL, LSR, ASR
type ImmOp = 0 | 1 | 2 | 3; // MOV, CMP, ADD, SUB

/** Format 1 — Move shifted register: LSL/LSR/ASR #imm5. */
function thumbShift(op: ShiftOp, offset: number, rs: number, rd: number): number {
  return ((op << 11) | ((offset & 0x1f) << 6) | ((rs & 0x7) << 3) | (rd & 0x7)) & 0xffff;
}

/** Format 2 — Add/subtract (register or 3-bit immediate). */
function thumbAddSub(isImm: boolean, isSub: boolean, arg: number, rs: number, rd: number): number {
  return (
    ((0b00011 << 11) |
      ((isImm ? 1 : 0) << 10) |
      ((isSub ? 1 : 0) << 9) |
      ((arg & 0x7) << 6) |
      ((rs & 0x7) << 3) |
      (rd & 0x7)) &
    0xffff
  );
}

/** Format 3 — MOV/CMP/ADD/SUB with 8-bit immediate. */
function thumbImm(op: ImmOp, rd: number, imm: number): number {
  return ((0b001 << 13) | (op << 11) | ((rd & 0x7) << 8) | (imm & 0xff)) & 0xffff;
}

function makeThumbCpu(instructions: number[]): ArmCpu {
  const bus = new FlatBus(0x10000);
  for (let i = 0; i < instructions.length; i++) bus.write16(i * 2, instructions[i]!);
  const cpu = new ArmCpu(bus, 0);
  cpu.regs.cpsr |= CPSR_T;
  return cpu;
}

describe("Thumb format 1 — move shifted register", () => {
  it("LSL #4 shifts left and updates Rd", () => {
    const cpu = makeThumbCpu([thumbShift(0, 4, 1, 0)]);
    cpu.regs.r[1] = 0x1;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x10);
  });

  it("LSL with carry-out updates C and N", () => {
    const cpu = makeThumbCpu([thumbShift(0, 1, 1, 0)]);
    cpu.regs.r[1] = 0xc0000000 | 0;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0x80000000);
    expect(cpu.regs.cFlag).toBe(true);
    expect(cpu.regs.nFlag).toBe(true);
    expect(cpu.regs.zFlag).toBe(false);
  });

  it("LSR #16 zero-extends the upper half", () => {
    const cpu = makeThumbCpu([thumbShift(1, 16, 1, 0)]);
    cpu.regs.r[1] = 0xabcd0000 | 0;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xabcd);
  });

  it("LSR #0 is decoded as LSR #32 (result = 0, C = bit 31)", () => {
    const cpu = makeThumbCpu([thumbShift(1, 0, 1, 0)]);
    cpu.regs.r[1] = 0x80000000 | 0;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.cFlag).toBe(true);
    expect(cpu.regs.zFlag).toBe(true);
  });

  it("ASR #1 sign-extends a negative value", () => {
    const cpu = makeThumbCpu([thumbShift(2, 1, 1, 0)]);
    cpu.regs.r[1] = 0x80000001 | 0;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xc0000000);
    expect(cpu.regs.cFlag).toBe(true);
    expect(cpu.regs.nFlag).toBe(true);
  });

  it("V flag is preserved across a shift", () => {
    const cpu = makeThumbCpu([thumbShift(0, 4, 1, 0)]);
    cpu.regs.cpsr = cpu.regs.cpsr | CPSR_V | 0;
    cpu.regs.r[1] = 0x1;
    cpu.step();
    expect(cpu.regs.vFlag).toBe(true);
  });
});

describe("Thumb format 2 — add/subtract", () => {
  it("ADD register: r2 = r0 + r1", () => {
    const cpu = makeThumbCpu([thumbAddSub(false, false, 1, 0, 2)]);
    cpu.regs.r[0] = 10;
    cpu.regs.r[1] = 20;
    cpu.step();
    expect(cpu.regs.r[2]).toBe(30);
  });

  it("SUB register: r2 = r0 - r1 sets C on no-borrow", () => {
    const cpu = makeThumbCpu([thumbAddSub(false, true, 1, 0, 2)]);
    cpu.regs.r[0] = 30;
    cpu.regs.r[1] = 10;
    cpu.step();
    expect(cpu.regs.r[2]).toBe(20);
    expect(cpu.regs.cFlag).toBe(true);
  });

  it("ADD 3-bit immediate: r0 = r1 + 7", () => {
    const cpu = makeThumbCpu([thumbAddSub(true, false, 7, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x107);
  });

  it("SUB 3-bit immediate: r0 = r1 - 1, Z when zero", () => {
    const cpu = makeThumbCpu([thumbAddSub(true, true, 1, 1, 0)]);
    cpu.regs.r[1] = 1;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.zFlag).toBe(true);
    expect(cpu.regs.cFlag).toBe(true);
  });

  it("ADD sets V on signed overflow", () => {
    const cpu = makeThumbCpu([thumbAddSub(false, false, 1, 0, 2)]);
    cpu.regs.r[0] = 0x7fffffff;
    cpu.regs.r[1] = 1;
    cpu.step();
    expect(cpu.regs.vFlag).toBe(true);
    expect(cpu.regs.nFlag).toBe(true);
  });
});

describe("Thumb format 3 — MOV/CMP/ADD/SUB immediate", () => {
  it("MOV r0, #0x42 sets the register and updates Z", () => {
    const cpu = makeThumbCpu([thumbImm(0, 0, 0x42)]);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
    expect(cpu.regs.zFlag).toBe(false);
    expect(cpu.regs.nFlag).toBe(false);
  });

  it("MOV r0, #0 sets Z", () => {
    const cpu = makeThumbCpu([thumbImm(0, 0, 0)]);
    cpu.step();
    expect(cpu.regs.zFlag).toBe(true);
  });

  it("MOV preserves C and V (they're not affected by a logical MOV)", () => {
    const cpu = makeThumbCpu([thumbImm(0, 0, 5)]);
    cpu.regs.cpsr = cpu.regs.cpsr | CPSR_C | CPSR_V | 0;
    cpu.step();
    expect(cpu.regs.cFlag).toBe(true);
    expect(cpu.regs.vFlag).toBe(true);
  });

  it("CMP r0, #5 sets flags but doesn't change r0", () => {
    const cpu = makeThumbCpu([thumbImm(1, 0, 5)]);
    cpu.regs.r[0] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(5);
    expect(cpu.regs.zFlag).toBe(true);
    expect(cpu.regs.cFlag).toBe(true); // no borrow
  });

  it("CMP r0, #10 with r0 = 5 clears C (borrow) and sets N", () => {
    const cpu = makeThumbCpu([thumbImm(1, 0, 10)]);
    cpu.regs.r[0] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(5);
    expect(cpu.regs.cFlag).toBe(false);
    expect(cpu.regs.nFlag).toBe(true);
  });

  it("ADD r0, #1 increments and updates flags", () => {
    const cpu = makeThumbCpu([thumbImm(2, 0, 1)]);
    cpu.regs.r[0] = 0x41;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
    expect(cpu.regs.zFlag).toBe(false);
  });

  it("SUB r0, #2 decrements", () => {
    const cpu = makeThumbCpu([thumbImm(3, 0, 2)]);
    cpu.regs.r[0] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(3);
    expect(cpu.regs.cFlag).toBe(true);
  });
});

describe("Thumb dispatch", () => {
  it("advances PC by 2 after each Thumb instruction", () => {
    const cpu = makeThumbCpu([thumbImm(0, 0, 1), thumbImm(0, 1, 2)]);
    cpu.step();
    expect(cpu.regs.r[15]).toBe(2);
    cpu.step();
    expect(cpu.regs.r[15]).toBe(4);
    expect(cpu.regs.r[0]).toBe(1);
    expect(cpu.regs.r[1]).toBe(2);
  });

  it("undefined cond=0xE encoding throws loudly", () => {
    // 0xDExx is the undefined slot in the conditional-branch family
    // (cond 0xE = AL, reused as the SWI escape via cond 0xF).
    const cpu = makeThumbCpu([0xde00]);
    expect(() => cpu.step()).toThrow(/undefined thumb encoding/i);
  });
});

type AluOp4 = number; // 4-bit Thumb format-4 opcode (0..15)

/** Format 4 — ALU op on low registers: 010000 <op4> Rs Rd. */
function thumbAlu(op: AluOp4, rs: number, rd: number): number {
  return ((0b010000 << 10) | ((op & 0xf) << 6) | ((rs & 0x7) << 3) | (rd & 0x7)) & 0xffff;
}

/** Format 5 — hi-register ADD/CMP/MOV/BX: 010001 OP H1 H2 Rs Rd. */
function thumbHi(op: 0 | 1 | 2 | 3, rdHi: number, rsHi: number): number {
  const h1 = rdHi >= 8 ? 1 : 0;
  const h2 = rsHi >= 8 ? 1 : 0;
  return ((0b010001 << 10) | (op << 8) | (h1 << 7) | (h2 << 6) | ((rsHi & 0x7) << 3) | (rdHi & 0x7)) & 0xffff;
}

describe("Thumb format 4 — ALU on low registers", () => {
  it("AND: logical AND, N/Z updated, C/V preserved", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0000, 1, 0)]);
    cpu.regs.r[0] = 0xff00ff00 | 0;
    cpu.regs.r[1] = 0x0ff00ff0;
    cpu.regs.cpsr = cpu.regs.cpsr | CPSR_C | CPSR_V | 0;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0x0f000f00);
    expect(cpu.regs.cFlag).toBe(true);
    expect(cpu.regs.vFlag).toBe(true);
  });

  it("EOR: exclusive OR", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0001, 1, 0)]);
    cpu.regs.r[0] = 0xff;
    cpu.regs.r[1] = 0x0f;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xf0);
  });

  it("LSL Rd, Rs: shift Rd left by Rs[7:0]", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0010, 1, 0)]);
    cpu.regs.r[0] = 0x1;
    cpu.regs.r[1] = 4;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x10);
  });

  it("LSR Rd, Rs: logical shift right exposes carry from bit (n-1)", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0011, 1, 0)]);
    cpu.regs.r[0] = 0x3;
    cpu.regs.r[1] = 1;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x1);
    expect(cpu.regs.cFlag).toBe(true);
  });

  it("ASR Rd, Rs: arithmetic shift sign-extends", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0100, 1, 0)]);
    cpu.regs.r[0] = 0x80000000 | 0;
    cpu.regs.r[1] = 1;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xc0000000);
    expect(cpu.regs.nFlag).toBe(true);
  });

  it("ADC: adds the C flag in", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0101, 1, 0)]);
    cpu.regs.r[0] = 0x10;
    cpu.regs.r[1] = 0x20;
    cpu.regs.cpsr = cpu.regs.cpsr | CPSR_C | 0;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x31);
  });

  it("SBC: subtracts an extra 1 when C=0", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0110, 1, 0)]);
    cpu.regs.r[0] = 0x10;
    cpu.regs.r[1] = 0x05;
    // C=0 → borrow
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x0a);
  });

  it("ROR Rd, Rs: rotate right by Rs[7:0]", () => {
    const cpu = makeThumbCpu([thumbAlu(0b0111, 1, 0)]);
    cpu.regs.r[0] = 0x00000001;
    cpu.regs.r[1] = 1;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0x80000000);
    expect(cpu.regs.cFlag).toBe(true);
  });

  it("TST: AND for flags only, doesn't write Rd", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1000, 1, 0)]);
    cpu.regs.r[0] = 0xf0;
    cpu.regs.r[1] = 0x0f;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xf0); // unchanged
    expect(cpu.regs.zFlag).toBe(true);
  });

  it("NEG Rd, Rs: Rd = -Rs (RSB with zero)", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1001, 1, 0)]);
    cpu.regs.r[1] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(-5);
    expect(cpu.regs.nFlag).toBe(true);
  });

  it("CMP Rd, Rs: sets flags only", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1010, 1, 0)]);
    cpu.regs.r[0] = 5;
    cpu.regs.r[1] = 5;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(5);
    expect(cpu.regs.zFlag).toBe(true);
    expect(cpu.regs.cFlag).toBe(true);
  });

  it("CMN: sets flags from Rd + Rs", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1011, 1, 0)]);
    cpu.regs.r[0] = 0xffffffff | 0;
    cpu.regs.r[1] = 1;
    cpu.step();
    expect(cpu.regs.zFlag).toBe(true);
    expect(cpu.regs.cFlag).toBe(true);
  });

  it("ORR: bitwise OR", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1100, 1, 0)]);
    cpu.regs.r[0] = 0x0f;
    cpu.regs.r[1] = 0xf0;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xff);
  });

  it("MUL: 32-bit multiply with truncation", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1101, 1, 0)]);
    cpu.regs.r[0] = 7;
    cpu.regs.r[1] = 6;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(42);
  });

  it("BIC: AND with complement", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1110, 1, 0)]);
    cpu.regs.r[0] = 0xff;
    cpu.regs.r[1] = 0x0f;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xf0);
  });

  it("MVN: Rd = NOT Rs", () => {
    const cpu = makeThumbCpu([thumbAlu(0b1111, 1, 0)]);
    cpu.regs.r[1] = 0x0000ffff;
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xffff0000);
    expect(cpu.regs.nFlag).toBe(true);
  });
});

describe("Thumb format 5 — hi-register operations", () => {
  it("ADD r8, r9 reaches into hi registers", () => {
    const cpu = makeThumbCpu([thumbHi(0b00, 8, 9)]);
    cpu.regs.r[8] = 100;
    cpu.regs.r[9] = 23;
    cpu.step();
    expect(cpu.regs.r[8]).toBe(123);
  });

  it("ADD doesn't update flags (note: unlike format-2 ADD)", () => {
    const cpu = makeThumbCpu([thumbHi(0b00, 8, 9)]);
    cpu.regs.r[8] = 0;
    cpu.regs.r[9] = 0;
    // Pre-set Z=false to verify it stays false.
    cpu.regs.zFlag = false;
    cpu.step();
    expect(cpu.regs.r[8]).toBe(0);
    expect(cpu.regs.zFlag).toBe(false);
  });

  it("CMP r8, r0 sets flags using the hi register", () => {
    const cpu = makeThumbCpu([thumbHi(0b01, 8, 0)]);
    cpu.regs.r[8] = 100;
    cpu.regs.r[0] = 50;
    cpu.step();
    expect(cpu.regs.zFlag).toBe(false);
    expect(cpu.regs.cFlag).toBe(true); // no borrow
  });

  it("MOV r0, r8 copies from hi to lo register, no flags", () => {
    const cpu = makeThumbCpu([thumbHi(0b10, 0, 8)]);
    cpu.regs.r[8] = 0xcafe;
    // Pre-set Z=true to verify MOV doesn't touch it.
    cpu.regs.zFlag = true;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xcafe);
    expect(cpu.regs.zFlag).toBe(true);
  });

  it("MOV pc, r0 branches with halfword alignment, state stays Thumb", () => {
    const cpu = makeThumbCpu([thumbHi(0b10, 15, 0)]);
    cpu.regs.r[0] = 0x41; // bit 0 set; MOV pc preserves bit-0 mask but state stays Thumb.
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
    expect(cpu.regs.tFlag).toBe(true);
  });

  it("BX r0 with even target switches to ARM and clears T", () => {
    const cpu = makeThumbCpu([thumbHi(0b11, 0, 0)]);
    cpu.regs.r[0] = 0x40;
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
    expect(cpu.regs.tFlag).toBe(false);
  });

  it("BX r0 with odd target stays in Thumb", () => {
    const cpu = makeThumbCpu([thumbHi(0b11, 0, 0)]);
    cpu.regs.r[0] = 0x41;
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x40);
    expect(cpu.regs.tFlag).toBe(true);
  });

  it("BX r14 (the standard subroutine return) works", () => {
    const cpu = makeThumbCpu([thumbHi(0b11, 0, 14)]);
    cpu.regs.r[14] = 0x100; // ARM-mode target
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x100);
    expect(cpu.regs.tFlag).toBe(false);
  });
});

/** Format 6 — PC-relative load: 01001 Rd word8. */
function thumbPcLoad(rd: number, word8: number): number {
  return ((0b01001 << 11) | ((rd & 0x7) << 8) | (word8 & 0xff)) & 0xffff;
}

/** Format 7 — load/store with register offset. */
function thumbLoadStoreReg(isLoad: boolean, isByte: boolean, ro: number, rb: number, rd: number): number {
  return (
    ((0b0101 << 12) |
      ((isLoad ? 1 : 0) << 11) |
      ((isByte ? 1 : 0) << 10) |
      (0 << 9) |
      ((ro & 0x7) << 6) |
      ((rb & 0x7) << 3) |
      (rd & 0x7)) &
    0xffff
  );
}

/** Format 8 — sign-extended / halfword load/store with register offset. */
function thumbLoadStoreSign(h: boolean, s: boolean, ro: number, rb: number, rd: number): number {
  return (
    ((0b0101 << 12) |
      ((h ? 1 : 0) << 11) |
      ((s ? 1 : 0) << 10) |
      (1 << 9) |
      ((ro & 0x7) << 6) |
      ((rb & 0x7) << 3) |
      (rd & 0x7)) &
    0xffff
  );
}

/** Format 9 — load/store with 5-bit immediate offset. */
function thumbLoadStoreImm(isByte: boolean, isLoad: boolean, offset5: number, rb: number, rd: number): number {
  return (
    ((0b011 << 13) |
      ((isByte ? 1 : 0) << 12) |
      ((isLoad ? 1 : 0) << 11) |
      ((offset5 & 0x1f) << 6) |
      ((rb & 0x7) << 3) |
      (rd & 0x7)) &
    0xffff
  );
}

/** Format 10 — load/store halfword with 5-bit immediate offset. */
function thumbLoadStoreHalfword(isLoad: boolean, offset5: number, rb: number, rd: number): number {
  return (
    ((0b1000 << 12) | ((isLoad ? 1 : 0) << 11) | ((offset5 & 0x1f) << 6) | ((rb & 0x7) << 3) | (rd & 0x7)) & 0xffff
  );
}

/** Format 11 — SP-relative load/store: 1001 L Rd word8. */
function thumbSpLoadStore(isLoad: boolean, rd: number, word8: number): number {
  return ((0b1001 << 12) | ((isLoad ? 1 : 0) << 11) | ((rd & 0x7) << 8) | (word8 & 0xff)) & 0xffff;
}

describe("Thumb format 6 — PC-relative load", () => {
  it("LDR r0, [PC, #imm] reads from PC+4 word-aligned + offset", () => {
    // PC at execution time = instruction_addr + 4 = 0 + 4 = 4, word-aligned.
    // imm8 = 1 → offset = 4. addr = 4 + 4 = 8.
    const cpu = makeThumbCpu([thumbPcLoad(0, 1)]);
    cpu.bus.write32(8, 0xdeadbeef | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xdeadbeef);
  });

  it("PC base is forced to word alignment", () => {
    // Instruction at 0x2, PC=0x6 → masked to 0x4. imm=1 → 0x4 + 4 = 0x8.
    const cpu = makeThumbCpu([thumbImm(0, 0, 0), thumbPcLoad(1, 1)]);
    cpu.bus.write32(8, 0x12345678);
    cpu.step(); // first MOV r0, #0 at 0x0
    cpu.step(); // LDR r1, [PC, #4] at 0x2
    expect(cpu.regs.r[1]).toBe(0x12345678);
  });
});

describe("Thumb format 7 — register-offset load/store", () => {
  it("LDR Rd, [Rb, Ro]", () => {
    const cpu = makeThumbCpu([thumbLoadStoreReg(true, false, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0x10;
    cpu.bus.write32(0x110, 0xcafef00d | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xcafef00d);
  });

  it("LDRB Rd, [Rb, Ro] zero-extends", () => {
    const cpu = makeThumbCpu([thumbLoadStoreReg(true, true, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0;
    cpu.bus.write8(0x100, 0xff);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xff);
  });

  it("STR Rd, [Rb, Ro]", () => {
    const cpu = makeThumbCpu([thumbLoadStoreReg(false, false, 2, 1, 0)]);
    cpu.regs.r[0] = 0x12345678;
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0x4;
    cpu.step();
    expect(cpu.bus.read32(0x104)).toBe(0x12345678);
  });

  it("STRB Rd, [Rb, Ro] writes only the low byte", () => {
    const cpu = makeThumbCpu([thumbLoadStoreReg(false, true, 2, 1, 0)]);
    cpu.regs.r[0] = 0x12345678;
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0;
    cpu.bus.write32(0x100, 0xffffffff | 0);
    cpu.step();
    expect(cpu.bus.read8(0x100)).toBe(0x78);
    expect(cpu.bus.read8(0x101)).toBe(0xff);
  });

  it("LDR from unaligned address rotates", () => {
    const cpu = makeThumbCpu([thumbLoadStoreReg(true, false, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0x1;
    cpu.bus.write32(0x100, 0x11223344);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0x44112233);
  });
});

describe("Thumb format 8 — sign-extended / halfword register offset", () => {
  it("STRH writes the low halfword", () => {
    const cpu = makeThumbCpu([thumbLoadStoreSign(false, false, 2, 1, 0)]);
    cpu.regs.r[0] = 0x12345678;
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0;
    cpu.step();
    expect(cpu.bus.read16(0x100)).toBe(0x5678);
  });

  it("LDRH zero-extends", () => {
    const cpu = makeThumbCpu([thumbLoadStoreSign(true, false, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0;
    cpu.bus.write16(0x100, 0xabcd);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xabcd);
  });

  it("LDSB sign-extends a negative byte", () => {
    const cpu = makeThumbCpu([thumbLoadStoreSign(false, true, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0;
    cpu.bus.write8(0x100, 0xff);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(-1);
  });

  it("LDSH sign-extends a negative halfword", () => {
    const cpu = makeThumbCpu([thumbLoadStoreSign(true, true, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.regs.r[2] = 0;
    cpu.bus.write16(0x100, 0xffff);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(-1);
  });
});

describe("Thumb format 9 — immediate-offset load/store", () => {
  it("LDR with imm5 word-scaled offset", () => {
    // offset5=2 → word offset=8.
    const cpu = makeThumbCpu([thumbLoadStoreImm(false, true, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write32(0x108, 0xfeedface | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xfeedface);
  });

  it("STR with imm5 word-scaled offset", () => {
    const cpu = makeThumbCpu([thumbLoadStoreImm(false, false, 1, 1, 0)]);
    cpu.regs.r[0] = 0xabcd1234 | 0;
    cpu.regs.r[1] = 0x100;
    cpu.step();
    expect(cpu.bus.read32(0x104) >>> 0).toBe(0xabcd1234);
  });

  it("LDRB with imm5 byte-scaled offset", () => {
    // offset5 = 3 → byte offset = 3.
    const cpu = makeThumbCpu([thumbLoadStoreImm(true, true, 3, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write8(0x103, 0x42);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
  });

  it("STRB with imm5 byte-scaled offset", () => {
    const cpu = makeThumbCpu([thumbLoadStoreImm(true, false, 2, 1, 0)]);
    cpu.regs.r[0] = 0xab;
    cpu.regs.r[1] = 0x100;
    cpu.step();
    expect(cpu.bus.read8(0x102)).toBe(0xab);
  });
});

describe("Thumb format 10 — halfword immediate offset", () => {
  it("LDRH with offset", () => {
    // offset5 = 2 → halfword offset = 4.
    const cpu = makeThumbCpu([thumbLoadStoreHalfword(true, 2, 1, 0)]);
    cpu.regs.r[1] = 0x100;
    cpu.bus.write16(0x104, 0xbeef);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xbeef);
  });

  it("STRH with offset", () => {
    const cpu = makeThumbCpu([thumbLoadStoreHalfword(false, 1, 1, 0)]);
    cpu.regs.r[0] = 0x1234;
    cpu.regs.r[1] = 0x100;
    cpu.step();
    expect(cpu.bus.read16(0x102)).toBe(0x1234);
  });
});

describe("Thumb format 11 — SP-relative load/store", () => {
  it("LDR Rd, [SP, #imm]", () => {
    const cpu = makeThumbCpu([thumbSpLoadStore(true, 0, 4)]);
    cpu.regs.r[13] = 0x1000;
    cpu.bus.write32(0x1010, 0xfeed);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0xfeed);
  });

  it("STR Rd, [SP, #imm]", () => {
    const cpu = makeThumbCpu([thumbSpLoadStore(false, 0, 2)]);
    cpu.regs.r[0] = 0xcafe;
    cpu.regs.r[13] = 0x1000;
    cpu.step();
    expect(cpu.bus.read32(0x1008)).toBe(0xcafe);
  });
});

/** Format 12 — Load address: 1010 SP Rd Word8. */
function thumbLoadAddress(useSp: boolean, rd: number, word8: number): number {
  return ((0b1010 << 12) | ((useSp ? 1 : 0) << 11) | ((rd & 0x7) << 8) | (word8 & 0xff)) & 0xffff;
}

/** Format 13 — Add offset to SP: 10110000 S SWord7. */
function thumbSpAdjust(isSub: boolean, word7: number): number {
  return ((0b10110000 << 8) | ((isSub ? 1 : 0) << 7) | (word7 & 0x7f)) & 0xffff;
}

/** Format 14 — Push/pop registers: 1011 L 10 R Rlist. */
function thumbPushPop(isPop: boolean, extra: boolean, rlist: number): number {
  return ((0b1011 << 12) | ((isPop ? 1 : 0) << 11) | (0b10 << 9) | ((extra ? 1 : 0) << 8) | (rlist & 0xff)) & 0xffff;
}

/** Format 15 — Multiple load/store: 1100 L Rb Rlist. */
function thumbLdmStm(isLoad: boolean, rb: number, rlist: number): number {
  return ((0b1100 << 12) | ((isLoad ? 1 : 0) << 11) | ((rb & 0x7) << 8) | (rlist & 0xff)) & 0xffff;
}

describe("Thumb format 12 — load address", () => {
  it("ADD Rd, PC, #imm8 << 2 uses word-aligned PC + 4 base", () => {
    // Instruction at 0x0: PC reads as 0x4, word-aligned. imm8=2 → offset=8 → r0 = 0xC.
    const cpu = makeThumbCpu([thumbLoadAddress(false, 0, 2)]);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x0c);
  });

  it("ADD Rd, PC, ... forces word alignment when PC is halfword-aligned", () => {
    // Two instructions: first MOV at 0x0 (PC=4), then ADR at 0x2 (PC=6, masked to 4).
    const cpu = makeThumbCpu([thumbImm(0, 0, 0), thumbLoadAddress(false, 1, 1)]);
    cpu.step();
    cpu.step();
    expect(cpu.regs.r[1]).toBe(0x08);
  });

  it("ADD Rd, SP, #imm8 << 2 uses SP base unmodified", () => {
    const cpu = makeThumbCpu([thumbLoadAddress(true, 0, 4)]);
    cpu.regs.r[13] = 0x1000;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x1010);
  });
});

describe("Thumb format 13 — SP arithmetic", () => {
  it("ADD SP, #imm7 << 2", () => {
    const cpu = makeThumbCpu([thumbSpAdjust(false, 4)]);
    cpu.regs.r[13] = 0x1000;
    cpu.step();
    expect(cpu.regs.r[13]).toBe(0x1010);
  });

  it("SUB SP, #imm7 << 2", () => {
    const cpu = makeThumbCpu([thumbSpAdjust(true, 2)]);
    cpu.regs.r[13] = 0x1000;
    cpu.step();
    expect(cpu.regs.r[13]).toBe(0x0ff8);
  });

  it("SP adjust does not touch flags", () => {
    const cpu = makeThumbCpu([thumbSpAdjust(true, 1)]);
    cpu.regs.r[13] = 0x1000;
    cpu.regs.zFlag = true;
    cpu.step();
    expect(cpu.regs.zFlag).toBe(true);
  });
});

describe("Thumb format 14 — push/pop", () => {
  it("PUSH {r0, r2} stores in ascending order, decrements SP by 8", () => {
    const cpu = makeThumbCpu([thumbPushPop(false, false, 0b00000101)]);
    cpu.regs.r[0] = 0x11111111;
    cpu.regs.r[2] = 0x22222222;
    cpu.regs.r[13] = 0x1000;
    cpu.step();
    expect(cpu.regs.r[13]).toBe(0x0ff8);
    expect(cpu.bus.read32(0x0ff8) >>> 0).toBe(0x11111111);
    expect(cpu.bus.read32(0x0ffc) >>> 0).toBe(0x22222222);
  });

  it("PUSH {r0, lr} pushes LR after the listed registers", () => {
    const cpu = makeThumbCpu([thumbPushPop(false, true, 0b00000001)]);
    cpu.regs.r[0] = 0xaaaaaaaa | 0;
    cpu.regs.r[14] = 0xbbbbbbbb | 0;
    cpu.regs.r[13] = 0x1000;
    cpu.step();
    expect(cpu.regs.r[13]).toBe(0x0ff8);
    expect(cpu.bus.read32(0x0ff8) >>> 0).toBe(0xaaaaaaaa);
    expect(cpu.bus.read32(0x0ffc) >>> 0).toBe(0xbbbbbbbb);
  });

  it("POP {r0, r2} loads in ascending order, increments SP by 8", () => {
    const cpu = makeThumbCpu([thumbPushPop(true, false, 0b00000101)]);
    cpu.regs.r[13] = 0x1000;
    cpu.bus.write32(0x1000, 0xdeadbeef | 0);
    cpu.bus.write32(0x1004, 0xcafef00d | 0);
    cpu.step();
    expect(cpu.regs.r[0]! >>> 0).toBe(0xdeadbeef);
    expect(cpu.regs.r[2]! >>> 0).toBe(0xcafef00d);
    expect(cpu.regs.r[13]).toBe(0x1008);
  });

  it("POP {PC} with even target stays in Thumb on ARMv4T (no interworking)", () => {
    // ARMv4T's POP {PC} (= LDMIA SP!, {..., PC}) loads PC but does NOT
    // switch T-bit based on bit 0 — interworking on LDM/POP was added
    // in ARMv5T. MMBN's IRQ glue depends on staying in Thumb here.
    const cpu = makeThumbCpu([thumbPushPop(true, true, 0)]);
    cpu.regs.r[13] = 0x1000;
    cpu.bus.write32(0x1000, 0x200);
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x200);
    expect(cpu.regs.tFlag).toBe(true);
    expect(cpu.regs.r[13]).toBe(0x1004);
  });

  it("POP {PC} with odd target stays in Thumb", () => {
    const cpu = makeThumbCpu([thumbPushPop(true, true, 0)]);
    cpu.regs.r[13] = 0x1000;
    cpu.bus.write32(0x1000, 0x201);
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x200);
    expect(cpu.regs.tFlag).toBe(true);
    expect(cpu.regs.r[13]).toBe(0x1004);
  });

  it("PUSH then POP round-trips a saved register", () => {
    const cpu = makeThumbCpu([thumbPushPop(false, false, 0b00000001), thumbPushPop(true, false, 0b00000010)]);
    cpu.regs.r[0] = 0xc0ffee;
    cpu.regs.r[13] = 0x1000;
    cpu.step();
    cpu.step();
    expect(cpu.regs.r[1]).toBe(0xc0ffee);
    expect(cpu.regs.r[13]).toBe(0x1000);
  });

  it("empty register list throws", () => {
    const cpu = makeThumbCpu([thumbPushPop(false, false, 0)]);
    expect(() => cpu.step()).toThrow(/empty register list/i);
  });
});

describe("Thumb format 15 — LDMIA/STMIA", () => {
  it("STMIA Rb!, {r1, r2} stores ascending, writes back Rb", () => {
    const cpu = makeThumbCpu([thumbLdmStm(false, 0, 0b00000110)]);
    cpu.regs.r[0] = 0x1000;
    cpu.regs.r[1] = 0x11111111;
    cpu.regs.r[2] = 0x22222222;
    cpu.step();
    expect(cpu.bus.read32(0x1000) >>> 0).toBe(0x11111111);
    expect(cpu.bus.read32(0x1004) >>> 0).toBe(0x22222222);
    expect(cpu.regs.r[0]).toBe(0x1008);
  });

  it("LDMIA Rb!, {r1, r2} loads ascending, writes back Rb", () => {
    const cpu = makeThumbCpu([thumbLdmStm(true, 0, 0b00000110)]);
    cpu.regs.r[0] = 0x1000;
    cpu.bus.write32(0x1000, 0xdeadbeef | 0);
    cpu.bus.write32(0x1004, 0xcafef00d | 0);
    cpu.step();
    expect(cpu.regs.r[1]! >>> 0).toBe(0xdeadbeef);
    expect(cpu.regs.r[2]! >>> 0).toBe(0xcafef00d);
    expect(cpu.regs.r[0]).toBe(0x1008);
  });

  it("STMIA with single register stores one word and bumps Rb by 4", () => {
    const cpu = makeThumbCpu([thumbLdmStm(false, 0, 0b00000010)]);
    cpu.regs.r[0] = 0x1000;
    cpu.regs.r[1] = 0xa5a5a5a5 | 0;
    cpu.step();
    expect(cpu.bus.read32(0x1000) >>> 0).toBe(0xa5a5a5a5);
    expect(cpu.regs.r[0]).toBe(0x1004);
  });

  it("LDMIA with Rb in list: loaded value wins (no writeback for Rb)", () => {
    const cpu = makeThumbCpu([thumbLdmStm(true, 1, 0b00000010)]);
    cpu.regs.r[1] = 0x1000;
    cpu.bus.write32(0x1000, 0xdeadbeef | 0);
    cpu.step();
    expect(cpu.regs.r[1]! >>> 0).toBe(0xdeadbeef);
  });

  it("STMIA with Rb first in list: stores ORIGINAL Rb, writeback applies", () => {
    const cpu = makeThumbCpu([thumbLdmStm(false, 0, 0b00000001)]);
    cpu.regs.r[0] = 0x1000;
    cpu.step();
    expect(cpu.bus.read32(0x1000) >>> 0).toBe(0x1000);
    expect(cpu.regs.r[0]).toBe(0x1004);
  });

  it("STMIA with Rb NOT first in list: stores WRITEBACK Rb", () => {
    const cpu = makeThumbCpu([thumbLdmStm(false, 1, 0b00000011)]);
    cpu.regs.r[0] = 0xaaaaaaaa | 0;
    cpu.regs.r[1] = 0x1000;
    cpu.step();
    expect(cpu.bus.read32(0x1000) >>> 0).toBe(0xaaaaaaaa);
    expect(cpu.bus.read32(0x1004) >>> 0).toBe(0x1008); // writeback value of r1
    expect(cpu.regs.r[1]).toBe(0x1008);
  });

  it("empty register list bumps Rb by 0x40 (ARM-encoding count=16)", () => {
    const cpu = makeThumbCpu([thumbLdmStm(true, 0, 0)]);
    cpu.regs.r[0] = 0x1000;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x1040);
  });
});

/** Format 16 — conditional branch: 1101 Cond SOffset8. */
function thumbCondBranch(cond: number, soffset8: number): number {
  return ((0b1101 << 12) | ((cond & 0xf) << 8) | (soffset8 & 0xff)) & 0xffff;
}

/** Format 17 — SWI: 11011111 Value8. */
function thumbSwi(value8: number): number {
  return ((0b11011111 << 8) | (value8 & 0xff)) & 0xffff;
}

/** Format 18 — unconditional branch: 11100 Offset11. */
function thumbUncondBranch(offset11: number): number {
  return ((0b11100 << 11) | (offset11 & 0x7ff)) & 0xffff;
}

/** Format 19 — long branch with link: 1111 H Offset11. */
function thumbLongBlHalf(isSecond: boolean, offset11: number): number {
  return ((0b1111 << 12) | ((isSecond ? 1 : 0) << 11) | (offset11 & 0x7ff)) & 0xffff;
}

describe("Thumb format 16 — conditional branch", () => {
  it("B EQ taken when Z is set", () => {
    // PC=4 at execute; offset = +4 → target = 4 + 4 = 0x8.
    const cpu = makeThumbCpu([thumbCondBranch(0x0, 0x02), thumbImm(0, 0, 0xff)]);
    cpu.regs.zFlag = true;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0x08);
  });

  it("B EQ NOT taken when Z is clear (falls through)", () => {
    const cpu = makeThumbCpu([thumbCondBranch(0x0, 0x02), thumbImm(0, 0, 0xff)]);
    cpu.regs.zFlag = false;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0x02);
  });

  it("B NE with negative offset branches backwards", () => {
    // Branch instruction located at 0x100. offset8 = 0xFE = -2 signed
    // → offset = -4. PC visible at execute = 0x100 + 4 = 0x104.
    // Target = 0x104 + (-4) = 0x100. (Infinite loop in real code; here
    // just verifies the sign-extension math.)
    const cpu = makeThumbCpu([]);
    cpu.bus.write16(0x100, thumbCondBranch(0x1, 0xfe));
    cpu.regs.r[15] = 0x100;
    cpu.regs.zFlag = false;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0x100);
  });

  it("B CS reproduces armwrestler's 0xD20B (cond=2, offset=11)", () => {
    // Sanity check on the dispatcher: this is the exact instruction
    // that halted Phase 2d's armwrestler run.
    const cpu = makeThumbCpu([thumbCondBranch(0x2, 0x0b)]);
    cpu.regs.cFlag = true;
    cpu.step();
    // PC=4 at execute, offset = 0xB << 1 = 22 → target = 4 + 22 = 26 = 0x1A.
    expect(cpu.regs.r[15]).toBe(0x1a);
  });
});

describe("Thumb format 17 — software interrupt", () => {
  it("SWI enters SVC mode, saves CPSR to SPSR, sets LR, jumps to 0x08", () => {
    const cpu = makeThumbCpu([thumbSwi(0x42)]);
    const cpsrBefore = cpu.regs.cpsr | 0;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0x08);
    expect(cpu.regs.cpsr & 0x1f).toBe(0x13); // SVC mode
    expect(cpu.regs.tFlag).toBe(false); // T cleared on exception entry
    expect((cpu.regs.cpsr & (1 << 7)) >>> 0).toBeGreaterThan(0); // I set
    expect(cpu.regs.spsr).toBe(cpsrBefore);
    expect(cpu.regs.r[14]).toBe(0x02); // address of next Thumb instruction
  });
});

describe("Thumb format 18 — unconditional branch", () => {
  it("forward branch", () => {
    // imm11 = 2 → offset = 4 → target = 4 + 4 = 8.
    const cpu = makeThumbCpu([thumbUncondBranch(2)]);
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0x08);
  });

  it("backward branch via 11-bit sign extension", () => {
    // Instruction at 0x100. imm11 = 0x7FC = -4 signed → offset = -8.
    // PC visible at execute = 0x100 + 4 = 0x104. Target = 0x104 - 8 = 0xFC.
    const cpu = makeThumbCpu([]);
    cpu.bus.write16(0x100, thumbUncondBranch(0x7fc));
    cpu.regs.r[15] = 0x100;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0xfc);
  });
});

describe("Thumb format 19 — long branch with link", () => {
  it("BL forward: first half loads LR-high, second half branches + sets LR", () => {
    // BL at 0x0/0x2 targeting 0x1004 (= PC_visible + 0x1000, where PC_visible = 0x4).
    // Split: high=1 (<< 12 = 0x1000), low=0 (<< 1 = 0).
    const cpu = makeThumbCpu([thumbLongBlHalf(false, 1), thumbLongBlHalf(true, 0)]);
    cpu.step(); // first half: LR ← 0x4 + (1 << 12) = 0x1004
    expect(cpu.regs.r[14]).toBe(0x1004);
    cpu.step(); // second half: PC ← LR + 0; LR ← 0x4 | 1 = 0x5
    expect(cpu.regs.r[15]! >>> 0).toBe(0x1004);
    expect(cpu.regs.r[14]).toBe(0x05);
  });

  it("BL with non-zero low offset combines high+low correctly", () => {
    // Target = (BL_pc_visible = 0x4) + 0x1234 = 0x1238.
    // 0x1234 split: high=1 (<< 12 = 0x1000), low=0x11A (<< 1 = 0x234).
    const cpu = makeThumbCpu([thumbLongBlHalf(false, 1), thumbLongBlHalf(true, 0x11a)]);
    cpu.step();
    cpu.step();
    expect(cpu.regs.r[15]! >>> 0).toBe(0x1238);
    expect(cpu.regs.r[14]).toBe(0x05);
  });

  it("BL backward: high half uses 11-bit sign extension", () => {
    // BL at 0x2000. high=0x7FF → sign-extends to -1, shifted << 12 = -0x1000.
    // LR ← (0x2000 + 4) + (-0x1000) = 0x1004.
    const cpu = makeThumbCpu([]);
    cpu.bus.write16(0x2000, thumbLongBlHalf(false, 0x7ff));
    cpu.bus.write16(0x2002, thumbLongBlHalf(true, 0));
    cpu.regs.r[15] = 0x2000;
    cpu.step();
    expect(cpu.regs.r[14]).toBe(0x1004);
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0x1004);
    expect(cpu.regs.r[14]).toBe(0x2005);
  });
});
