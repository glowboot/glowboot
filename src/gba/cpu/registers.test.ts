import { describe, expect, it } from "vitest";

import {
  ArmRegisters,
  CPSR_C,
  CPSR_F,
  CPSR_I,
  CPSR_N,
  CPSR_T,
  CPSR_V,
  CPSR_Z,
  MODE_ABT,
  MODE_FIQ,
  MODE_IRQ,
  MODE_SVC,
  MODE_SYS,
  MODE_UND,
  MODE_USR
} from "./registers.js";

describe("ArmRegisters defaults", () => {
  it("starts in SVC mode with IRQ + FIQ disabled in ARM state", () => {
    const regs = new ArmRegisters();
    expect(regs.mode).toBe(MODE_SVC);
    expect(regs.iFlag).toBe(true);
    expect(regs.fFlag).toBe(true);
    expect(regs.tFlag).toBe(false);
  });

  it("all 16 visible registers initialised to zero", () => {
    const regs = new ArmRegisters();
    for (let i = 0; i < 16; i++) expect(regs.r[i]).toBe(0);
  });

  it("CPSR flag bits sit in the correct positions", () => {
    expect(CPSR_T).toBe(1 << 5);
    expect(CPSR_F).toBe(1 << 6);
    expect(CPSR_I).toBe(1 << 7);
    expect(CPSR_V).toBe(1 << 28);
    expect(CPSR_C).toBe(1 << 29);
    expect(CPSR_Z).toBe(1 << 30);
    expect(CPSR_N).toBe(1 << 31);
  });
});

describe("ArmRegisters flag accessors", () => {
  it("round-trips N/Z/C/V flags through the bit positions", () => {
    const regs = new ArmRegisters();
    regs.nFlag = true;
    expect((regs.cpsr & CPSR_N) !== 0).toBe(true);
    regs.zFlag = true;
    regs.cFlag = true;
    regs.vFlag = true;
    expect(regs.nFlag).toBe(true);
    expect(regs.zFlag).toBe(true);
    expect(regs.cFlag).toBe(true);
    expect(regs.vFlag).toBe(true);
    regs.nFlag = false;
    expect(regs.nFlag).toBe(false);
    expect(regs.zFlag).toBe(true);
  });
});

describe("ArmRegisters mode switching — R13/R14 banking", () => {
  it("preserves user R13/R14 when entering and leaving IRQ", () => {
    const regs = new ArmRegisters();
    regs.setMode(MODE_USR);
    regs.r[13] = 0x03007f00;
    regs.r[14] = 0xdeadbeef | 0;

    regs.setMode(MODE_IRQ);
    expect(regs.r[13]).toBe(0);
    expect(regs.r[14]).toBe(0);
    regs.r[13] = 0x03007fa0;
    regs.r[14] = 0xfeedface | 0;

    regs.setMode(MODE_USR);
    expect(regs.r[13]).toBe(0x03007f00);
    expect(regs.r[14]).toBe(0xdeadbeef | 0);

    regs.setMode(MODE_IRQ);
    expect(regs.r[13]).toBe(0x03007fa0);
    expect(regs.r[14]).toBe(0xfeedface | 0);
  });

  it("usr and sys share the same R13/R14 bank", () => {
    const regs = new ArmRegisters();
    regs.setMode(MODE_USR);
    regs.r[13] = 0x11223344;
    regs.r[14] = 0x55667788;

    regs.setMode(MODE_SYS);
    expect(regs.r[13]).toBe(0x11223344);
    expect(regs.r[14]).toBe(0x55667788);
  });

  it("keeps R0–R7 across mode switches", () => {
    const regs = new ArmRegisters();
    for (let i = 0; i < 8; i++) regs.r[i] = (i + 1) * 0x100;
    regs.setMode(MODE_FIQ);
    for (let i = 0; i < 8; i++) expect(regs.r[i]).toBe((i + 1) * 0x100);
    regs.setMode(MODE_IRQ);
    for (let i = 0; i < 8; i++) expect(regs.r[i]).toBe((i + 1) * 0x100);
  });

  it("each privileged mode has its own R13/R14 bank", () => {
    const regs = new ArmRegisters();
    const modes = [MODE_USR, MODE_FIQ, MODE_IRQ, MODE_SVC, MODE_ABT, MODE_UND] as const;
    for (let i = 0; i < modes.length; i++) {
      regs.setMode(modes[i]!);
      regs.r[13] = 0xa0000000 | i;
      regs.r[14] = 0xb0000000 | i;
    }
    for (let i = 0; i < modes.length; i++) {
      regs.setMode(modes[i]!);
      expect(regs.r[13]! >>> 0).toBe((0xa0000000 | i) >>> 0);
      expect(regs.r[14]! >>> 0).toBe((0xb0000000 | i) >>> 0);
    }
  });
});

describe("ArmRegisters mode switching — R8–R12 banking", () => {
  it("banks R8–R12 only for FIQ", () => {
    const regs = new ArmRegisters();
    regs.setMode(MODE_USR);
    for (let i = 8; i <= 12; i++) regs.r[i] = i * 0x10;

    regs.setMode(MODE_IRQ);
    for (let i = 8; i <= 12; i++) expect(regs.r[i]).toBe(i * 0x10);

    regs.setMode(MODE_FIQ);
    for (let i = 8; i <= 12; i++) expect(regs.r[i]).toBe(0);
    for (let i = 8; i <= 12; i++) regs.r[i] = i * 0x100;

    regs.setMode(MODE_USR);
    for (let i = 8; i <= 12; i++) expect(regs.r[i]).toBe(i * 0x10);

    regs.setMode(MODE_FIQ);
    for (let i = 8; i <= 12; i++) expect(regs.r[i]).toBe(i * 0x100);
  });

  it("FIQ→IRQ saves FIQ R8–R12 and restores non-FIQ R8–R12", () => {
    const regs = new ArmRegisters();
    regs.setMode(MODE_USR);
    regs.r[10] = 0x42;
    regs.setMode(MODE_FIQ);
    regs.r[10] = 0x99;
    regs.setMode(MODE_IRQ);
    expect(regs.r[10]).toBe(0x42);
    regs.setMode(MODE_FIQ);
    expect(regs.r[10]).toBe(0x99);
  });
});

describe("ArmRegisters SPSR banking", () => {
  it("SPSR is per-privileged-mode", () => {
    const regs = new ArmRegisters();
    regs.setMode(MODE_IRQ);
    regs.spsr = 0x600000d3 | 0;
    regs.setMode(MODE_SVC);
    regs.spsr = 0x80000010 | 0;
    regs.setMode(MODE_IRQ);
    expect(regs.spsr).toBe(0x600000d3 | 0);
    regs.setMode(MODE_SVC);
    expect(regs.spsr).toBe(0x80000010 | 0);
  });

  it("SPSR access in usr/sys returns CPSR and is write-ignored", () => {
    const regs = new ArmRegisters();
    regs.setMode(MODE_USR);
    const before = regs.cpsr;
    regs.spsr = 0xdeadbeef | 0;
    expect(regs.spsr).toBe(before);
    expect(regs.cpsr).toBe(before);
  });
});

describe("ArmRegisters setMode preserves CPSR flags", () => {
  it("only the mode bits change when switching modes", () => {
    const regs = new ArmRegisters();
    regs.nFlag = true;
    regs.cFlag = true;
    const flagsBefore = regs.cpsr & (CPSR_N | CPSR_Z | CPSR_C | CPSR_V | CPSR_I | CPSR_F | CPSR_T);
    regs.setMode(MODE_FIQ);
    const flagsAfter = regs.cpsr & (CPSR_N | CPSR_Z | CPSR_C | CPSR_V | CPSR_I | CPSR_F | CPSR_T);
    expect(flagsAfter).toBe(flagsBefore);
    expect(regs.mode).toBe(MODE_FIQ);
  });
});

describe("ArmRegisters setMode handles reserved mode encodings without crashing", () => {
  it("treats reserved mode bits as USR for register banking", () => {
    // Reserved modes share USR's bank on real ARM7TDMI. MMBN's IRQ glue
    // relies on this — its handler MSR's CPSR to mode 0x14 between
    // IRQ-window guards, and the cart's user stack must follow the
    // mode switch instead of being stranded in the previous mode's bank.
    const regs = new ArmRegisters();
    regs.setMode(MODE_FIQ);
    regs.r[13] = 0x1111_1111 | 0;
    expect(() => regs.setMode(0x14)).not.toThrow();
    expect(regs.mode).toBe(0x14);
    // FIQ → 0x14 (USR-bank) swapped FIQ's r13 out; r13 now reflects
    // the USR bank's saved value (0 by default).
    expect(regs.r[13]! >>> 0).toBe(0);
    // Recovery: writing back to FIQ restores FIQ's r13 from the bank.
    regs.setMode(MODE_FIQ);
    expect(regs.r[13]! >>> 0).toBe(0x1111_1111);
  });
});
