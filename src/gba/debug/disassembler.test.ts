import { describe, expect, it } from "vitest";

import { combineThumbBl, decodeArm, decodeThumb } from "./disassembler.js";

/**
 * Tests target the load-bearing instruction families used by real
 * game code. Coverage is intentionally a sample rather than the full
 * encoding space — the disassembler is a "minimum-useful" build, and
 * the v1 acceptance bar is "every common pattern decodes recognisably,
 * unknowns degrade to raw hex". For each family we verify mnemonic,
 * operand string shape, length, and (where applicable) the resolved
 * targetAddr.
 */

describe("ARM disassembler", () => {
  describe("data processing", () => {
    it("MOV with immediate (mov r0, #1)", () => {
      // cond=AL, 001 (imm class), op=13 (MOV), S=0, Rn=0 (ignored), Rd=0,
      // rotate=0, imm=1 → 0xE3A00001
      const d = decodeArm(0xe3a00001, 0);
      expect(d.mnemonic).toBe("MOV");
      expect(d.operands).toBe("r0, #$1");
      expect(d.length).toBe(4);
      expect(d.targetAddr).toBeUndefined();
    });

    it("MOV with S flag (movs r0, #0)", () => {
      // Same as above with S=1 → 0xE3B00000
      const d = decodeArm(0xe3b00000, 0);
      expect(d.mnemonic).toBe("MOVS");
      expect(d.operands).toBe("r0, #$0");
    });

    it("ADD with shifted register (add r0, r1, r2, lsl #4)", () => {
      // cond=AL, 000 (reg class), op=4 (ADD), S=0, Rn=1, Rd=0,
      // shift_amt=4, shift_type=0 (LSL), Rm=2
      // = 1110 000 0100 0 0001 0000 00100 00 0 0010
      // = 0xE0810202
      const d = decodeArm(0xe0810202, 0);
      expect(d.mnemonic).toBe("ADD");
      expect(d.operands).toBe("r0, r1, r2, LSL #4");
    });

    it("CMP omits Rd (cmp r0, #5)", () => {
      // cond=AL, 001, op=10 (CMP), S forced to 1 by hw but we
      // suppress the S suffix on compare-like ops. Rn=0, Rd=0, imm=5
      // = 0xE3500005
      const d = decodeArm(0xe3500005, 0);
      expect(d.mnemonic).toBe("CMP");
      expect(d.operands).toBe("r0, #$5");
    });

    it("conditional execution gets the suffix (moveq r0, #1)", () => {
      // cond=EQ (0), rest same as MOV r0, #1 → 0x03A00001
      const d = decodeArm(0x03a00001, 0);
      expect(d.mnemonic).toBe("MOVEQ");
    });
  });

  describe("branches", () => {
    it("BL resolves the target address from PC + 8 + (offset << 2)", () => {
      // bl 0x08000010 from pc=0x08000000:
      //   offset = (target - (pc+8)) >> 2 = (0x10 - 0x8) >> 2 = 2
      // cond=AL, 101 (branch class), L=1, off24=2 → 0xEB000002
      const d = decodeArm(0xeb000002, 0x08000000);
      expect(d.mnemonic).toBe("BL");
      expect(d.operands).toBe("$08000010");
      expect(d.targetAddr).toBe(0x08000010);
    });

    it("B (no link) decodes as B not BL", () => {
      // Same as above with L=0 → 0xEA000002
      const d = decodeArm(0xea000002, 0x08000000);
      expect(d.mnemonic).toBe("B");
      expect(d.targetAddr).toBe(0x08000010);
    });

    it("backwards branch sign-extends correctly", () => {
      // off24 = -2 (0xFFFFFE): from pc=0x08000020, target = 0x20+8+(-2<<2) = 0x20
      // wait that's pc+8-8 = pc. Use off=-1: 0x20+8-4 = 0x24. Let me use -2 anyway:
      // pc=0x08000020, off=0xFFFFFE (sign-extended -2), target = pc+8 + (-2 << 2) = 0x08000020 + 8 - 8 = 0x08000020
      const d = decodeArm(0xeafffffe, 0x08000020);
      expect(d.mnemonic).toBe("B");
      expect(d.targetAddr).toBe(0x08000020);
    });

    it("BX Rm — ARM↔Thumb interwork", () => {
      // bx lr (r14): cond=AL, 0x012FFF1, Rm=14 → 0xE12FFF1E
      const d = decodeArm(0xe12fff1e, 0);
      expect(d.mnemonic).toBe("BX");
      expect(d.operands).toBe("lr");
    });
  });

  describe("data transfer", () => {
    it("LDR Rd, [Rn, #imm]", () => {
      // ldr r0, [r1, #4]: cond=AL, 01 (xfer), I=0, P=1, U=1, B=0, W=0, L=1,
      // Rn=1, Rd=0, imm12=4
      // = 1110 01 0 1 1 0 0 1 0001 0000 0000 0000 0100
      // = 0xE5910004
      const d = decodeArm(0xe5910004, 0);
      expect(d.mnemonic).toBe("LDR");
      expect(d.operands).toBe("r0, [r1, #$4]");
    });

    it("STRB Rd, [Rn, #imm]", () => {
      // strb r2, [r3, #1]: same shape with B=1, L=0, Rn=3, Rd=2, imm=1
      // = 1110 01 0 1 1 1 0 0 0011 0010 0000 0000 0001
      // = 0xE5C32001
      const d = decodeArm(0xe5c32001, 0);
      expect(d.mnemonic).toBe("STRB");
      expect(d.operands).toBe("r2, [r3, #$1]");
    });

    it("LDM with register list (ldmia sp!, {r0, r4-r6, lr})", () => {
      // cond=AL, 100 (block xfer), P=0, U=1, S=0, W=1, L=1,
      // Rn=13 (sp), rlist = r0 | r4 | r5 | r6 | r14
      // rlist = 0x4071
      // = 1110 100 0 1 0 1 1 1101 0100 0000 0111 0001
      // = 0xE8BD4071
      const d = decodeArm(0xe8bd4071, 0);
      expect(d.mnemonic).toBe("LDMIA");
      expect(d.operands).toBe("sp!, {r0, r4-r6, lr}");
    });

    it("STMDB (push) renders the descending mode suffix", () => {
      // stmdb sp!, {r4-r6, lr}: P=1, U=0, S=0, W=1, L=0, Rn=13, rlist=0x4070
      // = 1110 100 1 0 0 1 0 1101 0100 0000 0111 0000
      // = 0xE92D4070
      const d = decodeArm(0xe92d4070, 0);
      expect(d.mnemonic).toBe("STMDB");
      expect(d.operands).toBe("sp!, {r4-r6, lr}");
    });
  });

  describe("SWI / multiply / status reg", () => {
    it("SWI carries the 24-bit comment field", () => {
      // swi #5: cond=AL, 1111 (SWI), comment24=5 → 0xEF000005
      const d = decodeArm(0xef000005, 0);
      expect(d.mnemonic).toBe("SWI");
      expect(d.operands).toBe("#$5");
    });

    it("MUL Rd, Rm, Rs", () => {
      // mul r0, r1, r2: cond=AL, 000 0 0 0 0 0 Rd Rn=0 Rs=2 1001 Rm=1
      // (A=0 = MUL, S=0; Rn is ignored — fixed at 0)
      // bits: 1110 0000 0000 0000 0000 0010 1001 0001
      // = 0xE0000291
      const d = decodeArm(0xe0000291, 0);
      expect(d.mnemonic).toBe("MUL");
      expect(d.operands).toBe("r0, r1, r2");
    });

    it("MRS reads the status register", () => {
      // mrs r0, cpsr: cond=AL, 00010 R=0 001111 Rd=0 000000000000
      // = 1110 0001 0000 1111 0000 0000 0000 0000
      // = 0xE10F0000
      const d = decodeArm(0xe10f0000, 0);
      expect(d.mnemonic).toBe("MRS");
      expect(d.operands).toBe("r0, CPSR");
    });
  });

  describe("coprocessor", () => {
    it("CDP — coprocessor data processing", () => {
      // cdp p15, 0, c0, c1, c2, 0
      //   cond=AL, 1110 (bits 27-24), op1=0 (bits 23-20),
      //   CRn=1, CRd=0, cp=15, op2=0, bit4=0, CRm=2
      // = 1110 1110 0000 0001 0000 1111 0000 0010
      // = 0xEE010F02
      const d = decodeArm(0xee010f02, 0);
      expect(d.mnemonic).toBe("CDP");
      expect(d.operands).toBe("p15, 0, c0, c1, c2, 0");
    });

    it("MCR — move ARM register to coprocessor", () => {
      // mcr p15, 0, r0, c1, c0, 0
      //   cond=AL, 1110, op1=0 (bits 23-21), L=0 (bit 20),
      //   CRn=1, Rd=0, cp=15, op2=0, bit4=1, CRm=0
      // = 1110 1110 0000 0001 0000 1111 0001 0000
      // = 0xEE010F10
      const d = decodeArm(0xee010f10, 0);
      expect(d.mnemonic).toBe("MCR");
      expect(d.operands).toBe("p15, 0, r0, c1, c0, 0");
    });

    it("MRC — move coprocessor register to ARM", () => {
      // Same shape as MCR with L=1 → 0xEE110F10
      const d = decodeArm(0xee110f10, 0);
      expect(d.mnemonic).toBe("MRC");
      expect(d.operands).toBe("p15, 0, r0, c1, c0, 0");
    });

    it("LDC — coprocessor load with imm offset", () => {
      // ldc p2, c4, [r1, #16]
      //   cond=AL, 110 (bits 27-25), P=1, U=1, N=0, W=0, L=1,
      //   Rn=1, CRd=4, cp=2, imm8=4 (× 4 = 16 bytes)
      // = 1110 1101 1001 0001 0100 0010 0000 0100
      // = 0xED914204
      const d = decodeArm(0xed914204, 0);
      expect(d.mnemonic).toBe("LDC");
      expect(d.operands).toBe("p2, c4, [r1, #$10]");
    });

    it("STCL — long-form coprocessor store with pre-indexed negative offset", () => {
      // stcl p2, c4, [r1, #-8]
      //   cond=AL, 110 (bits 27-25), P=1, U=0, N=1, W=0, L=0,
      //   Rn=1, CRd=4, cp=2, imm8=2 (× 4 = 8 bytes, negated)
      //   bit layout 1110 110 1 0100 0001 0100 0010 0000 0010
      // = 0xED414202
      const d = decodeArm(0xed414202, 0);
      expect(d.mnemonic).toBe("STCL");
      expect(d.operands).toBe("p2, c4, [r1, #-$8]");
    });
  });

  describe("undefined-instruction trap", () => {
    it("register-form SDT with bit 4 = 1 is the UND encoding", () => {
      // The slot at bits 27-25=011 / bit 4=1 is reserved for the
      // explicit UND trap (ARM ARM §A3.21). Any opcode matching it
      // decodes as UND with the raw word as the operand so the user
      // can tell which encoding the assembler emitted.
      // Pick: cond=AL, 0110_0000_0000_0000_0000_0000_0001_0000 = 0xE6000010
      const d = decodeArm(0xe6000010, 0);
      expect(d.mnemonic).toBe("UND");
      expect(d.operands).toBe("$E6000010");
      expect(d.length).toBe(4);
    });
  });

  describe("fallback", () => {
    it("ARMv5+ NV-conditional encodings outside the v4T set decode as .word", () => {
      // cond=NV (0xF) is reserved on ARMv4T for the unconditional
      // ARMv5+ encodings (BLX, PLD, etc.). v4T treats these as raw data.
      const d = decodeArm(0xfa000000, 0);
      expect(d.mnemonic).toBe(".word");
      expect(d.operands).toBe("$FA000000");
      expect(d.length).toBe(4);
    });
  });
});

describe("Thumb disassembler", () => {
  it("Format 1 — LSL Rd, Rs, #imm5", () => {
    // lsl r0, r1, #4: 000 op=00 imm5=4 rs=1 rd=0
    // = 0000 0001 0000 1000 = 0x0108
    const d = decodeThumb(0x0108, 0);
    expect(d.mnemonic).toBe("LSL");
    expect(d.operands).toBe("r0, r1, #4");
    expect(d.length).toBe(2);
  });

  it("Format 2 — ADD r0, r1, r2 (register form)", () => {
    // 00011 I=0 op=0 rn=2 rs=1 rd=0 → 0001 1000 1000 1000 = 0x1888
    const d = decodeThumb(0x1888, 0);
    expect(d.mnemonic).toBe("ADD");
    expect(d.operands).toBe("r0, r1, r2");
  });

  it("Format 3 — MOV r0, #$2A", () => {
    // 001 op=00 rd=0 imm8=0x2A → 0010 0000 0010 1010 = 0x202A
    const d = decodeThumb(0x202a, 0);
    expect(d.mnemonic).toBe("MOV");
    expect(d.operands).toBe("r0, #$2A");
  });

  it("Format 4 — ALU op (and r0, r1)", () => {
    // 010000 op=0000 rs=1 rd=0 → 0100 0000 0000 1000 = 0x4008
    const d = decodeThumb(0x4008, 0);
    expect(d.mnemonic).toBe("AND");
    expect(d.operands).toBe("r0, r1");
  });

  it("Format 5 — BX lr (the canonical return)", () => {
    // 010001 op=11 H1=0 H2=1 rs(lo)=110 rd=000
    // = 0100 0111 0111 0000 = 0x4770
    const d = decodeThumb(0x4770, 0);
    expect(d.mnemonic).toBe("BX");
    expect(d.operands).toBe("lr");
  });

  it("Format 6 — PC-relative load resolves through aligned PC + 4", () => {
    // ldr r0, [pc, #8] at pc=0x08000100:
    //   target = ((pc+4) & ~3) + 8*4? No — imm8=8 gives offset = 8 (byte units shown).
    //   Actually offset in the instruction is imm8*4 (instruction docs). Let's
    //   pick imm8=2 → byte offset 8 → target = ((0x08000100+4) & ~3) + 8 = 0x0800010C
    // 01001 rd=0 imm8=2 → 0100 1000 0000 0010 = 0x4802
    const d = decodeThumb(0x4802, 0x08000100);
    expect(d.mnemonic).toBe("LDR");
    expect(d.targetAddr).toBe(0x0800010c);
  });

  it("Format 14 — PUSH {r0, r4, lr}", () => {
    // 1011 L=0 10 R=1 rlist=0x11 (r0 | r4)
    // = 1011 0101 0001 0001 = 0xB511
    const d = decodeThumb(0xb511, 0);
    expect(d.mnemonic).toBe("PUSH");
    // r0 + r4 + lr (R-bit adds lr to the push-list)
    expect(d.operands).toBe("{r0, r4, lr}");
  });

  it("Format 14 — POP {r0, r4, pc} (R-bit adds pc on pop)", () => {
    // 1011 L=1 10 R=1 rlist=0x11 → 1011 1101 0001 0001 = 0xBD11
    const d = decodeThumb(0xbd11, 0);
    expect(d.mnemonic).toBe("POP");
    expect(d.operands).toBe("{r0, r4, pc}");
  });

  it("Format 16 — conditional branch resolves through PC + 4", () => {
    // beq target from pc=0x08000100: imm8=4 (byte offset 8) → target = 0x08000100+4+8 = 0x0800010C
    // 1101 cond=0 imm8=4 → 1101 0000 0000 0100 = 0xD004
    const d = decodeThumb(0xd004, 0x08000100);
    expect(d.mnemonic).toBe("BEQ");
    expect(d.targetAddr).toBe(0x0800010c);
  });

  it("Format 17 — SWI #imm8", () => {
    // 11011111 imm8=5 → 1101 1111 0000 0101 = 0xDF05
    const d = decodeThumb(0xdf05, 0);
    expect(d.mnemonic).toBe("SWI");
    expect(d.operands).toBe("#$5");
  });

  it("Format 18 — unconditional branch", () => {
    // b target from pc=0x08000100, off=2 (byte offset 4) → 0x08000100+4+4 = 0x08000108
    // 11100 imm11=2 → 1110 0000 0000 0010 = 0xE002
    const d = decodeThumb(0xe002, 0x08000100);
    expect(d.mnemonic).toBe("B");
    expect(d.targetAddr).toBe(0x08000108);
  });

  it("Format 19 — BL pair halves are decoded separately", () => {
    // First half (H=0): 11110 imm11(high) → 0xF000 with off=0
    const hi = decodeThumb(0xf000, 0x08000100);
    expect(hi.mnemonic).toBe("BL");
    expect(hi.operands).toContain("(hi)");
    // Second half (H=1): 11111 imm11(low)=2 → 0xF802
    const lo = decodeThumb(0xf802, 0x08000102);
    expect(lo.mnemonic).toBe("BL");
    expect(lo.operands).toContain("(lo)");
  });

  it("combineThumbBl walks the two halves to the absolute target", () => {
    // hi half encodes upper 11 bits of a 22-bit offset. With hi=0 (offset=0)
    // and lo=4 (low 11 bits), target = pcHi + 4 + (0 << 12) + (4 << 1)
    //   = 0x08000100 + 4 + 8 = 0x0800010C
    const target = combineThumbBl(0xf000, 0xf804, 0x08000100);
    expect(target).toBe(0x0800010c);
  });

  it("fallback — unknown halfword decodes as .hword", () => {
    // 0xDE00 sits in the conditional-branch range but its cond field
    // (0xE) is reserved on ARM7TDMI Thumb; the decoder returns it as
    // raw .hword to surface that visibly.
    const d = decodeThumb(0xde00, 0);
    expect(d.mnemonic).toBe(".hword");
    expect(d.operands).toBe("$DE00");
    expect(d.length).toBe(2);
  });
});
