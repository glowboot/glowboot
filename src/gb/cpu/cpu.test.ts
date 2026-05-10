import { beforeEach, describe, expect, it } from "vitest";

import { InterruptController } from "../memory/interrupts.js";
import type { MMU } from "../memory/mmu.js";
import { Timer } from "../timer/timer.js";
import { CPU } from "./cpu.js";

/**
 * Minimal flat-memory stub standing in for the full MMU. Backs reads and
 * writes to a 64 KiB byte array so opcode tests can load a tiny program
 * at 0x0100 (the post-boot PC) and single-step it, without having to
 * construct a Cartridge (which requires a valid Nintendo-logo fingerprint)
 * or a PPU / APU / Joypad.
 */
function makeStubMmu(): { mem: Uint8Array; mmu: MMU } {
  const mem = new Uint8Array(0x10000);
  const mmu = {
    readByte: (addr: number) => mem[addr & 0xffff]!,
    writeByte: (addr: number, value: number) => {
      mem[addr & 0xffff] = value & 0xff;
    },
    tickDma: () => {}
  } as unknown as MMU;
  return { mem, mmu };
}

function makeCpu(): { cpu: CPU; mem: Uint8Array } {
  const { mem, mmu } = makeStubMmu();
  const interrupts = new InterruptController();
  const timer = new Timer(interrupts);
  const cpu = new CPU(mmu, interrupts, timer, /* cgb */ false);
  return { cpu, mem };
}

/** Load a program at 0x0100 (post-boot PC) and single-step it. */
function loadAt(mem: Uint8Array, addr: number, bytes: number[]): void {
  mem.set(bytes, addr);
}

describe("CPU", () => {
  let cpu: CPU;
  let mem: Uint8Array;

  beforeEach(() => {
    ({ cpu, mem } = makeCpu());
  });

  describe("NOP", () => {
    it("advances PC by 1 and takes 1 M-cycle", () => {
      loadAt(mem, 0x0100, [0x00]); // NOP
      const cycles = cpu.step();
      expect(cycles).toBe(1);
      expect(cpu.regs.pc).toBe(0x0101);
    });
  });

  describe("LD A, d8 (0x3E) — 8-bit immediate load", () => {
    it("loads the immediate byte into A and takes 2 M-cycles", () => {
      loadAt(mem, 0x0100, [0x3e, 0x42]);
      const cycles = cpu.step();
      expect(cycles).toBe(2);
      expect(cpu.regs.a).toBe(0x42);
      expect(cpu.regs.pc).toBe(0x0102);
    });
  });

  describe("ADD A, d8 (0xC6) — 8-bit add immediate", () => {
    it("sets Z flag on 0 result, clears N", () => {
      cpu.regs.a = 0xff;
      loadAt(mem, 0x0100, [0xc6, 0x01]); // ADD A, 0x01 → 0x00 (wraps)
      cpu.step();
      expect(cpu.regs.a).toBe(0);
      expect(cpu.regs.zf).toBe(true);
      expect(cpu.regs.nf).toBe(false);
      expect(cpu.regs.cf).toBe(true); // carry out
      expect(cpu.regs.hf).toBe(true); // half-carry: 0x0F + 0x01 = 0x10
    });

    it("computes half-carry correctly on 0x0F + 0x01", () => {
      cpu.regs.a = 0x0f;
      loadAt(mem, 0x0100, [0xc6, 0x01]);
      cpu.step();
      expect(cpu.regs.a).toBe(0x10);
      expect(cpu.regs.hf).toBe(true);
      expect(cpu.regs.cf).toBe(false);
    });
  });

  describe("SUB d8 (0xD6) — 8-bit subtract immediate", () => {
    it("sets N flag, and Z when result is zero", () => {
      cpu.regs.a = 0x42;
      loadAt(mem, 0x0100, [0xd6, 0x42]);
      cpu.step();
      expect(cpu.regs.a).toBe(0);
      expect(cpu.regs.zf).toBe(true);
      expect(cpu.regs.nf).toBe(true);
      expect(cpu.regs.cf).toBe(false);
    });

    it("sets C flag on borrow", () => {
      cpu.regs.a = 0x00;
      loadAt(mem, 0x0100, [0xd6, 0x01]);
      cpu.step();
      expect(cpu.regs.a).toBe(0xff);
      expect(cpu.regs.cf).toBe(true);
    });
  });

  describe("INC / DEC 8-bit — affects Z, N, H but NOT C", () => {
    it("INC B (0x04) 0x0F → 0x10 sets H", () => {
      cpu.regs.b = 0x0f;
      cpu.regs.cf = true; // should NOT be affected
      loadAt(mem, 0x0100, [0x04]);
      cpu.step();
      expect(cpu.regs.b).toBe(0x10);
      expect(cpu.regs.hf).toBe(true);
      expect(cpu.regs.nf).toBe(false);
      expect(cpu.regs.cf).toBe(true); // preserved
    });

    it("DEC B (0x05) 0x01 → 0x00 sets Z", () => {
      cpu.regs.b = 0x01;
      loadAt(mem, 0x0100, [0x05]);
      cpu.step();
      expect(cpu.regs.b).toBe(0);
      expect(cpu.regs.zf).toBe(true);
      expect(cpu.regs.nf).toBe(true);
    });
  });

  describe("JP a16 (0xC3) — unconditional absolute jump", () => {
    it("jumps to the 16-bit immediate and takes 4 M-cycles", () => {
      loadAt(mem, 0x0100, [0xc3, 0x34, 0x12]);
      const cycles = cpu.step();
      expect(cycles).toBe(4);
      expect(cpu.regs.pc).toBe(0x1234);
    });
  });

  describe("CALL / RET round trip", () => {
    it("CALL pushes return address, RET pops it", () => {
      // 0x0100: CALL 0x0200
      // 0x0200: RET
      loadAt(mem, 0x0100, [0xcd, 0x00, 0x02]);
      loadAt(mem, 0x0200, [0xc9]);

      const initialSp = cpu.regs.sp;
      cpu.step(); // CALL
      expect(cpu.regs.pc).toBe(0x0200);
      expect(cpu.regs.sp).toBe(initialSp - 2);

      cpu.step(); // RET
      expect(cpu.regs.pc).toBe(0x0103); // past the CALL
      expect(cpu.regs.sp).toBe(initialSp);
    });
  });

  describe("EI + interrupt servicing", () => {
    it("EI defers IME enable by one instruction", () => {
      loadAt(mem, 0x0100, [0xfb, 0x00, 0x00]); // EI; NOP; NOP
      expect(cpu.ime).toBe(false);
      cpu.step(); // EI — IME still false after this step
      expect(cpu.ime).toBe(false);
      cpu.step(); // NOP — IME becomes true before this
      expect(cpu.ime).toBe(true);
    });
  });

  describe("DAA (0x27) — BCD adjust", () => {
    it("adjusts A after a BCD addition that produces a non-BCD nibble", () => {
      // 0x15 + 0x27 = 0x3C (not BCD). DAA adjusts to 0x42 (correct BCD sum).
      cpu.regs.a = 0x15;
      loadAt(mem, 0x0100, [0xc6, 0x27, 0x27]); // ADD A, 0x27; DAA
      cpu.step(); // ADD
      cpu.step(); // DAA
      expect(cpu.regs.a).toBe(0x42);
      expect(cpu.regs.zf).toBe(false);
    });
  });
});
