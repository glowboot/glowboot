import { describe, expect, it } from "vitest";

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
  ALU_RSC,
  ALU_SBC,
  ALU_SUB,
  ALU_TEQ,
  ALU_TST
} from "./alu.js";

describe("alu — logical ops use shifter carry and preserve V", () => {
  it("AND computes Rn & Op2 and writes back", () => {
    const r = alu(ALU_AND, 0xff00ff00 | 0, 0x0ff00ff0, false, true, true);
    expect(r.value).toBe(0x0f000f00);
    expect(r.writes).toBe(true);
    expect(r.flags.c).toBe(true);
    expect(r.flags.v).toBe(true);
  });

  it("EOR sets Z when operands match", () => {
    const r = alu(ALU_EOR, 0x12345678, 0x12345678, false, false, false);
    expect(r.value).toBe(0);
    expect(r.flags.z).toBe(true);
    expect(r.flags.n).toBe(false);
  });

  it("MOV ignores Rn entirely", () => {
    const r = alu(ALU_MOV, 0xdeadbeef | 0, 0x42, false, false, false);
    expect(r.value).toBe(0x42);
  });

  it("MVN bitwise-inverts the operand", () => {
    const r = alu(ALU_MVN, 0, 0x0000ffff, false, false, false);
    expect(r.value).toBe(0xffff0000 | 0);
    expect(r.flags.n).toBe(true);
  });

  it("BIC clears bits", () => {
    const r = alu(ALU_BIC, 0xffffffff | 0, 0x0000ff00, false, false, false);
    expect(r.value >>> 0).toBe(0xffff00ff);
  });

  it("ORR sets bits", () => {
    const r = alu(ALU_ORR, 0x000000f0, 0x0000000f, false, false, false);
    expect(r.value).toBe(0x000000ff);
  });

  it("TST is AND without writeback", () => {
    const r = alu(ALU_TST, 0xff, 0x01, false, false, true);
    expect(r.writes).toBe(false);
    expect(r.flags.z).toBe(false);
    expect(r.flags.c).toBe(true);
  });

  it("TEQ is EOR without writeback", () => {
    const r = alu(ALU_TEQ, 0xff, 0xff, false, false, false);
    expect(r.writes).toBe(false);
    expect(r.flags.z).toBe(true);
  });
});

describe("alu — ADD / CMN", () => {
  it("ADD computes the sum and clears C/V for non-overflowing input", () => {
    const r = alu(ALU_ADD, 0x100, 0x200, false, false, false);
    expect(r.value).toBe(0x300);
    expect(r.flags.c).toBe(false);
    expect(r.flags.v).toBe(false);
  });

  it("ADD sets C on unsigned overflow", () => {
    const r = alu(ALU_ADD, 0xffffffff | 0, 1, false, false, false);
    expect(r.value).toBe(0);
    expect(r.flags.c).toBe(true);
    expect(r.flags.z).toBe(true);
  });

  it("ADD sets V on signed overflow (positive + positive → negative)", () => {
    const r = alu(ALU_ADD, 0x7fffffff, 1, false, false, false);
    expect(r.value).toBe(0x80000000 | 0);
    expect(r.flags.v).toBe(true);
    expect(r.flags.n).toBe(true);
    expect(r.flags.c).toBe(false);
  });

  it("CMN matches ADD but doesn't write back", () => {
    const r = alu(ALU_CMN, 0x7fffffff, 1, false, false, false);
    expect(r.writes).toBe(false);
    expect(r.flags.v).toBe(true);
  });
});

describe("alu — SUB / CMP", () => {
  it("SUB computes the difference and sets C on no-borrow", () => {
    const r = alu(ALU_SUB, 0x10, 0x05, false, false, false);
    expect(r.value).toBe(0x0b);
    expect(r.flags.c).toBe(true);
    expect(r.flags.v).toBe(false);
  });

  it("SUB clears C on borrow", () => {
    const r = alu(ALU_SUB, 0x05, 0x10, false, false, false);
    expect(r.value).toBe(-0x0b);
    expect(r.flags.c).toBe(false);
    expect(r.flags.n).toBe(true);
  });

  it("SUB sets V on signed overflow (positive - negative → negative)", () => {
    const r = alu(ALU_SUB, 0x7fffffff, 0x80000000 | 0, false, false, false);
    expect(r.flags.v).toBe(true);
  });

  it("CMP matches SUB but doesn't write back", () => {
    const r = alu(ALU_CMP, 0x10, 0x10, false, false, false);
    expect(r.writes).toBe(false);
    expect(r.flags.z).toBe(true);
    expect(r.flags.c).toBe(true);
  });

  it("RSB is reverse SUB", () => {
    const r = alu(ALU_RSB, 0x05, 0x10, false, false, false);
    expect(r.value).toBe(0x0b);
  });
});

describe("alu — ADC / SBC / RSC carry-in", () => {
  it("ADC adds the C flag in", () => {
    // alu() returns a reused scratch instance — consume each result
    // before the next call.
    expect(alu(ALU_ADC, 0x10, 0x20, false, false, false).value).toBe(0x30);
    expect(alu(ALU_ADC, 0x10, 0x20, true, false, false).value).toBe(0x31);
  });

  it("SBC subtracts an extra 1 when C=0 (borrow)", () => {
    expect(alu(ALU_SBC, 0x10, 0x05, true, false, false).value).toBe(0x0b);
    expect(alu(ALU_SBC, 0x10, 0x05, false, false, false).value).toBe(0x0a);
  });

  it("RSC swaps Rn/Op2 versus SBC", () => {
    const r = alu(ALU_RSC, 0x05, 0x10, true, false, false);
    expect(r.value).toBe(0x0b);
  });
});

describe("alu — N and Z flag derivation", () => {
  it("N follows bit 31 of the result regardless of op family", () => {
    const r = alu(ALU_MOV, 0, 0x80000000 | 0, false, false, false);
    expect(r.flags.n).toBe(true);
  });

  it("Z is set iff result is exactly zero", () => {
    expect(alu(ALU_MOV, 0, 0, false, false, false).flags.z).toBe(true);
    expect(alu(ALU_MOV, 0, 1, false, false, false).flags.z).toBe(false);
  });
});
