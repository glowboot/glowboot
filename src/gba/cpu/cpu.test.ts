import { describe, expect, it } from "vitest";

import { FlatBus } from "../memory/bus.js";
import { InterruptController, IRQ_VBLANK } from "../memory/interrupts.js";
import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import { ALU_ADD, ALU_CMP, ALU_MOV, ALU_SUB, type AluOp } from "./alu.js";
import { COND_AL, COND_EQ, COND_HI, COND_NE } from "./conditions.js";
import { ArmCpu } from "./cpu.js";
import { CPSR_I, CPSR_T, MODE_IRQ, MODE_SYS } from "./registers.js";
import { SHIFT_LSL, type ShiftType } from "./shifter.js";

const I_BIT = 1 << 25;
const S_BIT = 1 << 20;
const ROM_BASE = 0x08000000;
const STACK_TOP = 0x03007f00;

function dpImm(cond: number, op: AluOp, s: boolean, rn: number, rd: number, rot: number, imm8: number): number {
  return (cond << 28) | I_BIT | (op << 21) | (s ? S_BIT : 0) | (rn << 16) | (rd << 12) | (rot << 8) | (imm8 & 0xff) | 0;
}

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

function branch(cond: number, fromAddr: number, toAddr: number, link = false): number {
  const offset = ((toAddr - fromAddr - 8) >> 2) & 0xffffff;
  return (cond << 28) | (0b101 << 25) | ((link ? 1 : 0) << 24) | offset | 0;
}

function ldrstr(opts: {
  load: boolean;
  byte?: boolean;
  preIndex?: boolean;
  up?: boolean;
  writeback?: boolean;
  rn: number;
  rd: number;
  immOffset: number;
}): number {
  const p = opts.preIndex ?? true;
  const u = opts.up ?? true;
  return (
    (COND_AL << 28) |
    (0b010 << 25) |
    ((p ? 1 : 0) << 24) |
    ((u ? 1 : 0) << 23) |
    ((opts.byte ? 1 : 0) << 22) |
    ((opts.writeback ? 1 : 0) << 21) |
    ((opts.load ? 1 : 0) << 20) |
    (opts.rn << 16) |
    (opts.rd << 12) |
    (opts.immOffset & 0xfff) |
    0
  );
}

function ldmstm(opts: {
  load: boolean;
  preIndex?: boolean;
  up?: boolean;
  writeback?: boolean;
  rn: number;
  rlist: number;
}): number {
  return (
    (COND_AL << 28) |
    (0b100 << 25) |
    ((opts.preIndex ? 1 : 0) << 24) |
    ((opts.up ? 1 : 0) << 23) |
    ((opts.writeback ? 1 : 0) << 21) |
    ((opts.load ? 1 : 0) << 20) |
    (opts.rn << 16) |
    (opts.rlist & 0xffff) |
    0
  );
}

function loadFlatProgram(instructions: number[]): ArmCpu {
  const bus = new FlatBus(0x10000);
  for (let i = 0; i < instructions.length; i++) bus.write32(i * 4, instructions[i]!);
  return new ArmCpu(bus, 0);
}

function loadRomProgram(rom: Uint8Array, offset: number, instructions: number[]): void {
  for (let i = 0; i < instructions.length; i++) {
    const v = instructions[i]! | 0;
    rom[offset + i * 4] = v & 0xff;
    rom[offset + i * 4 + 1] = (v >>> 8) & 0xff;
    rom[offset + i * 4 + 2] = (v >>> 16) & 0xff;
    rom[offset + i * 4 + 3] = (v >>> 24) & 0xff;
  }
}

function runUntil(cpu: ArmCpu, doneAddr: number, maxSteps = 20000): number {
  for (let i = 0; i < maxSteps; i++) {
    if (cpu.regs.r[15]! >>> 0 === doneAddr >>> 0) return i;
    cpu.step();
  }
  throw new Error(
    `Integration test budget (${maxSteps} steps) exceeded; final PC = 0x${(cpu.regs.r[15]! >>> 0).toString(16)}`
  );
}

function makeIrqCpu(): { cpu: ArmCpu; ic: InterruptController; mem: ReturnType<typeof makeGbaMemoryMap> } {
  const mem = makeGbaMemoryMap();
  const cpu = new ArmCpu(mem.bus, 0x08000000);
  cpu.interrupts = mem.interrupts;
  cpu.regs.setMode(MODE_SYS);
  cpu.regs.cpsr &= ~CPSR_I;
  cpu.regs.r[13] = 0x03007f00;
  return { cpu, ic: mem.interrupts, mem };
}

function makePrefetchCpu(): { cpu: ArmCpu; mem: ReturnType<typeof makeGbaMemoryMap> } {
  const mem = makeGbaMemoryMap(0x10000);
  const cpu = new ArmCpu(mem.bus, 0x02000000);
  cpu.regs.setMode(MODE_SYS);
  cpu.regs.cpsr &= ~CPSR_I;
  cpu.regs.r[13] = 0x03007f00;
  return { cpu, mem };
}

describe("ArmCpu", () => {
  it("constructor seeds PC from the entry argument", () => {
    const cpu = new ArmCpu(new FlatBus(0x100), 0x40);
    expect(cpu.regs.r[15]).toBe(0x40);
  });

  it("dispatches to Thumb step when CPSR.T is set", () => {
    const cpu = new ArmCpu(new FlatBus(0x100), 0);
    // Thumb encoding for `MOV r0, #0x42`: format 3, op=00, Rd=0, imm8=0x42 → 0x2042.
    cpu.bus.write16(0, 0x2042);
    cpu.regs.cpsr |= CPSR_T;
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
  });

  it("runs a small ARM program end-to-end (countdown loop)", () => {
    // r0 = 5; while (r0 != 0) r0--;  — branch backwards via MOV{NE} pc, #4.
    const program = [
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 5),
      dpImm(COND_AL, ALU_SUB, true, 0, 0, 0, 1),
      dpImm(COND_NE, ALU_MOV, false, 0, 15, 0, 4),
      dpImm(COND_AL, ALU_MOV, false, 0, 1, 0, 0xaa)
    ];
    const cpu = loadFlatProgram(program);
    for (let i = 0; i < 100; i++) {
      cpu.step();
      if (cpu.regs.r[15] === 0x10) break;
    }
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0);
    expect(cpu.regs.r[1]).toBe(0xaa);
    expect(cpu.regs.zFlag).toBe(true);
  });

  it("CMP-then-conditional-MOV implements unsigned max(r0, r1) → r2", () => {
    const program = [
      dpReg(COND_AL, ALU_MOV, false, 0, 2, 0, SHIFT_LSL, 0),
      dpReg(COND_AL, ALU_CMP, true, 1, 0, 0, SHIFT_LSL, 0),
      dpReg(COND_HI, ALU_MOV, false, 0, 2, 0, SHIFT_LSL, 1)
    ];
    const cpu = loadFlatProgram(program);
    cpu.regs.r[0] = 0x100;
    cpu.regs.r[1] = 0x200;
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.regs.r[2]).toBe(0x200);
  });

  it("ADD chain — r0 = 1 + 2 + 3 + 4", () => {
    const program = [
      dpImm(COND_AL, ALU_MOV, false, 0, 0, 0, 1),
      dpImm(COND_AL, ALU_ADD, false, 0, 0, 0, 2),
      dpImm(COND_AL, ALU_ADD, false, 0, 0, 0, 3),
      dpImm(COND_AL, ALU_ADD, false, 0, 0, 0, 4)
    ];
    const cpu = loadFlatProgram(program);
    cpu.step();
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.regs.r[0]).toBe(10);
  });
});

describe("ArmCpu — IRQ delivery", () => {
  it("does not take an IRQ when controller.pending is false", () => {
    const { cpu } = makeIrqCpu();
    const pcBefore = cpu.regs.r[15];
    cpu.step();
    expect(cpu.regs.r[15]).not.toBe(pcBefore);
    expect(cpu.regs.cpsr & 0x1f).toBe(MODE_SYS);
  });

  it("does not take an IRQ when CPSR.I is set even if controller.pending is true", () => {
    const { cpu, ic } = makeIrqCpu();
    cpu.regs.cpsr |= CPSR_I;
    ic.ime = 1;
    ic.ie = 1 << IRQ_VBLANK;
    ic.raise(IRQ_VBLANK);
    const cpsrBefore = cpu.regs.cpsr;
    cpu.step();
    expect(cpu.regs.cpsr & 0x1f).toBe(cpsrBefore & 0x1f);
  });

  it("switches to IRQ mode + jumps to 0x18 when IRQ is pending and CPSR.I clear", () => {
    const { cpu, ic } = makeIrqCpu();
    ic.ime = 1;
    ic.ie = 1 << IRQ_VBLANK;
    ic.raise(IRQ_VBLANK);
    // First step ARMS the IRQ (samples pending=true). Second step
    // takes the exception. This one-step lag matches ARM7TDMI's
    // sample-then-take pattern; without it, timer-overflow IRQs fire
    // mid-test-sequence before the cart's follow-up writes land.
    cpu.step();
    expect(cpu.regs.cpsr & 0x1f).toBe(MODE_SYS);
    const pcAfterFirst = cpu.regs.r[15]! | 0;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(0x18);
    expect(cpu.regs.cpsr & 0x1f).toBe(MODE_IRQ);
    expect(cpu.regs.cpsr & CPSR_I).toBe(CPSR_I);
    expect(cpu.regs.cpsr & CPSR_T).toBe(0);
    expect(cpu.regs.r[14]).toBe(pcAfterFirst + 4);
  });
});

describe("ArmCpu — BIOS IRQ vector HLE", () => {
  it("at PC=0x18: pushes r0-r3, r12, lr and jumps to the user handler", () => {
    const { cpu, ic, mem } = makeIrqCpu();
    const userHandler = 0x02000040;
    mem.bus.write32(0x03007ffc, userHandler);
    cpu.regs.setMode(MODE_IRQ);
    cpu.regs.r[13] = 0x03007fa0;
    cpu.regs.r[14] = 0x08000020;
    cpu.regs.r[0] = 0xaaaa0000;
    cpu.regs.r[1] = 0xaaaa0001;
    cpu.regs.r[2] = 0xaaaa0002;
    cpu.regs.r[3] = 0xaaaa0003;
    cpu.regs.r[12] = 0xaaaa000c;
    cpu.regs.r[15] = 0x18;
    cpu.step();
    expect(cpu.regs.r[15]).toBe(userHandler);
    expect(cpu.regs.r[14]).toBe(0x128);
    expect(cpu.regs.r[13]).toBe(0x03007fa0 - 24);
    const sp = cpu.regs.r[13]! | 0;
    expect(mem.bus.read32(sp)).toBe(0xaaaa0000 | 0);
    expect(mem.bus.read32(sp + 4)).toBe(0xaaaa0001 | 0);
    expect(mem.bus.read32(sp + 8)).toBe(0xaaaa0002 | 0);
    expect(mem.bus.read32(sp + 12)).toBe(0xaaaa0003 | 0);
    expect(mem.bus.read32(sp + 16)).toBe(0xaaaa000c | 0);
    expect(mem.bus.read32(sp + 20)).toBe(0x08000020 | 0);
    void ic;
  });

  it("at PC=0x128 (exit vector): pops registers and returns to interrupted code in original mode", () => {
    const { cpu, mem } = makeIrqCpu();
    const sp = 0x03007f80;
    mem.bus.write32(sp, 0x11111111);
    mem.bus.write32(sp + 4, 0x22222222);
    mem.bus.write32(sp + 8, 0x33333333);
    mem.bus.write32(sp + 12, 0x44444444);
    mem.bus.write32(sp + 16, 0x12121212);
    const returnAddr = 0x08000020;
    mem.bus.write32(sp + 20, returnAddr);
    cpu.regs.setMode(MODE_IRQ);
    cpu.regs.r[13] = sp;
    cpu.regs.spsr = MODE_SYS;
    cpu.regs.r[15] = 0x128;
    cpu.step();
    expect(cpu.regs.cpsr & 0x1f).toBe(MODE_SYS);
    expect(cpu.regs.r[15]).toBe(returnAddr - 4);
    expect(cpu.regs.r[0]).toBe(0x11111111 | 0);
    expect(cpu.regs.r[1]).toBe(0x22222222 | 0);
    expect(cpu.regs.r[2]).toBe(0x33333333 | 0);
    expect(cpu.regs.r[3]).toBe(0x44444444 | 0);
    expect(cpu.regs.r[12]).toBe(0x12121212 | 0);
  });
});

describe("ArmCpu — instruction prefetch FIFO", () => {
  // ARM7TDMI prefetches two instructions ahead of the currently
  // executing one. A STR that overwrites those upcoming addresses
  // must not affect what actually executes — the cached opcodes run.
  // This is the behaviour jsmolka-nes test 1 verifies; locking it in
  // here ensures future refactors of `ArmCpu.step` don't regress.

  it("STR that overwrites the next instruction does not affect the current step", () => {
    const { cpu, mem } = makePrefetchCpu();
    mem.bus.write32(0x02000000, 0xe3a00042); // mov r0, #0x42
    mem.bus.write32(0x02000004, 0xe3a05042); // mov r5, #0x42 — should execute as-is
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
    mem.bus.write32(0x02000004, 0xe3a060ff);
    cpu.step();
    expect(cpu.regs.r[5]).toBe(0x42);
    expect(cpu.regs.r[6]).toBe(0);
  });

  it("FIFO survives writes to PC+8 (the one-after-next instruction)", () => {
    const { cpu, mem } = makePrefetchCpu();
    mem.bus.write32(0x02000000, 0xe1a00000); // mov r0, r0 (NOP-equivalent)
    mem.bus.write32(0x02000004, 0xe3a00001); // mov r0, #1
    mem.bus.write32(0x02000008, 0xe3a01002); // mov r1, #2 — to be overwritten
    mem.bus.write32(0x0200000c, 0xe3a02003); // mov r2, #3 — to be overwritten

    cpu.step();
    mem.bus.write32(0x02000004, 0xe3a000ff);
    mem.bus.write32(0x02000008, 0xe3a010ff);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(1);
    cpu.step();
    expect(cpu.regs.r[1]).toBe(2);
  });

  it("FIFO invalidates on branch — next fetch reads current memory", () => {
    const { cpu, mem } = makePrefetchCpu();
    mem.bus.write32(0x02000000, 0xea000000); // b 0x02000008
    mem.bus.write32(0x02000004, 0xe3a000ff); // (skipped)
    mem.bus.write32(0x02000008, 0xe3a00042); // mov r0, #0x42

    cpu.step();
    expect((cpu.regs.r[15]! >>> 0) & 0xffffffff).toBe(0x02000008);
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x42);
  });
});

describe("ArmCpu integration — memcpy", () => {
  it("copies N bytes from src to dst via LDRB/STRB post-increment loop", () => {
    // Layout (ROM at 0x08000000):
    //   0x00: CMP r2, #0
    //   0x04: BEQ done
    //   0x08: LDRB r3, [r0], #1
    //   0x0C: STRB r3, [r1], #1
    //   0x10: SUB  r2, r2, #1
    //   0x14: B    loop
    //   0x18: done: B done
    const DONE = ROM_BASE + 0x18;
    const program = [
      dpImm(COND_AL, ALU_CMP, true, 2, 0, 0, 0),
      branch(COND_EQ, ROM_BASE + 0x04, DONE),
      ldrstr({ load: true, byte: true, preIndex: false, rn: 0, rd: 3, immOffset: 1 }),
      ldrstr({ load: false, byte: true, preIndex: false, rn: 1, rd: 3, immOffset: 1 }),
      dpImm(COND_AL, ALU_SUB, false, 2, 2, 0, 1),
      branch(COND_AL, ROM_BASE + 0x14, ROM_BASE),
      branch(COND_AL, DONE, DONE)
    ];
    const mem = makeGbaMemoryMap();
    loadRomProgram(mem.rom, 0, program);

    const data = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22];
    for (let i = 0; i < data.length; i++) mem.iwram[i] = data[i]!;

    const cpu = new ArmCpu(mem.bus, ROM_BASE);
    cpu.regs.r[0] = 0x03000000;
    cpu.regs.r[1] = 0x03000100;
    cpu.regs.r[2] = data.length;

    runUntil(cpu, DONE);

    for (let i = 0; i < data.length; i++) {
      expect(mem.iwram[0x100 + i]).toBe(data[i]);
    }
    expect(cpu.regs.r[2]).toBe(0);
  });
});

describe("ArmCpu integration — strlen", () => {
  it("counts the bytes up to the first NUL terminator", () => {
    // Layout:
    //   0x00: MOV r1, #0
    //   0x04: top: LDRB r2, [r0]
    //   0x08: CMP r2, #0
    //   0x0C: BEQ done
    //   0x10: ADD r0, r0, #1
    //   0x14: ADD r1, r1, #1
    //   0x18: B top
    //   0x1C: done: B done
    const DONE = ROM_BASE + 0x1c;
    const program = [
      dpImm(COND_AL, ALU_MOV, false, 0, 1, 0, 0),
      ldrstr({ load: true, byte: true, rn: 0, rd: 2, immOffset: 0 }),
      dpImm(COND_AL, ALU_CMP, true, 2, 0, 0, 0),
      branch(COND_EQ, ROM_BASE + 0x0c, DONE),
      dpImm(COND_AL, ALU_ADD, false, 0, 0, 0, 1),
      dpImm(COND_AL, ALU_ADD, false, 1, 1, 0, 1),
      branch(COND_AL, ROM_BASE + 0x18, ROM_BASE + 0x04),
      branch(COND_AL, DONE, DONE)
    ];
    const mem = makeGbaMemoryMap();
    loadRomProgram(mem.rom, 0, program);

    const STR = 0x03000000;
    const text = "HELLO";
    for (let i = 0; i < text.length; i++) mem.iwram[i] = text.charCodeAt(i);
    mem.iwram[text.length] = 0;

    const cpu = new ArmCpu(mem.bus, ROM_BASE);
    cpu.regs.r[0] = STR;

    runUntil(cpu, DONE);

    expect(cpu.regs.r[1]).toBe(text.length);
  });
});

describe("ArmCpu integration — subroutine call with stack frame", () => {
  it("BL + STMDB/LDMIA + MOV pc, lr round-trip preserves caller state", () => {
    // Subroutine `add42(r0) → r0 + 42` that saves/restores r4 and lr.
    //
    // sub (at ROM_BASE + 0x00):
    //   0x00: STMDB sp!, {r4, lr}    ; push caller-saved r4 + lr
    //   0x04: MOV r4, #42            ; r4 = 42
    //   0x08: ADD r0, r0, r4          ; r0 += r4
    //   0x0C: LDMIA sp!, {r4, lr}    ; pop r4 + lr
    //   0x10: MOV pc, lr              ; return
    //
    // main (at ROM_BASE + 0x100):
    //   0x100: BL sub
    //   0x104: done: B done
    const SUB = ROM_BASE + 0x00;
    const MAIN = ROM_BASE + 0x100;
    const DONE = ROM_BASE + 0x104;
    const subProgram = [
      ldmstm({ load: false, preIndex: true, up: false, writeback: true, rn: 13, rlist: (1 << 4) | (1 << 14) }),
      dpImm(COND_AL, ALU_MOV, false, 0, 4, 0, 42),
      dpReg(COND_AL, ALU_ADD, false, 0, 0, 0, SHIFT_LSL, 4),
      ldmstm({ load: true, preIndex: false, up: true, writeback: true, rn: 13, rlist: (1 << 4) | (1 << 14) }),
      dpReg(COND_AL, ALU_MOV, false, 0, 15, 0, SHIFT_LSL, 14)
    ];
    const mainProgram = [branch(COND_AL, MAIN, SUB, true), branch(COND_AL, DONE, DONE)];
    const mem = makeGbaMemoryMap();
    loadRomProgram(mem.rom, 0, subProgram);
    loadRomProgram(mem.rom, 0x100, mainProgram);

    const cpu = new ArmCpu(mem.bus, MAIN);
    cpu.regs.r[13] = STACK_TOP;
    cpu.regs.r[0] = 100;
    cpu.regs.r[4] = 0xcafe;

    runUntil(cpu, DONE);

    expect(cpu.regs.r[0]).toBe(142);
    expect(cpu.regs.r[4]).toBe(0xcafe);
    expect(cpu.regs.r[13]).toBe(STACK_TOP);
  });
});

describe("ArmCpu integration — sum of a 32-bit array", () => {
  it("accumulates 8 little-endian words via LDR with post-increment", () => {
    // Layout:
    //   0x00: MOV r3, #0       ; accumulator
    //   0x04: top: CMP r2, #0
    //   0x08: BEQ done
    //   0x0C: LDR r4, [r0], #4
    //   0x10: ADD r3, r3, r4
    //   0x14: SUB r2, r2, #1
    //   0x18: B top
    //   0x1C: done: MOV r0, r3
    //   0x20: B done (spin)
    const DONE = ROM_BASE + 0x20;
    const program = [
      dpImm(COND_AL, ALU_MOV, false, 0, 3, 0, 0),
      dpImm(COND_AL, ALU_CMP, true, 2, 0, 0, 0),
      branch(COND_EQ, ROM_BASE + 0x08, ROM_BASE + 0x1c),
      ldrstr({ load: true, preIndex: false, rn: 0, rd: 4, immOffset: 4 }),
      dpReg(COND_AL, ALU_ADD, false, 3, 3, 0, SHIFT_LSL, 4),
      dpImm(COND_AL, ALU_SUB, false, 2, 2, 0, 1),
      branch(COND_AL, ROM_BASE + 0x18, ROM_BASE + 0x04),
      dpReg(COND_AL, ALU_MOV, false, 0, 0, 0, SHIFT_LSL, 3),
      branch(COND_AL, DONE, DONE)
    ];
    const mem = makeGbaMemoryMap();
    loadRomProgram(mem.rom, 0, program);

    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      mem.iwram[i * 4 + 0] = v & 0xff;
      mem.iwram[i * 4 + 1] = (v >>> 8) & 0xff;
      mem.iwram[i * 4 + 2] = (v >>> 16) & 0xff;
      mem.iwram[i * 4 + 3] = (v >>> 24) & 0xff;
    }

    const cpu = new ArmCpu(mem.bus, ROM_BASE);
    cpu.regs.r[0] = 0x03000000;
    cpu.regs.r[2] = values.length;

    runUntil(cpu, DONE);

    expect(cpu.regs.r[0]).toBe(36);
  });
});
