import { describe, expect, it } from "vitest";

import {
  checkCondition,
  COND_AL,
  COND_CC,
  COND_CS,
  COND_EQ,
  COND_GE,
  COND_GT,
  COND_HI,
  COND_LE,
  COND_LS,
  COND_LT,
  COND_MI,
  COND_NE,
  COND_NV,
  COND_PL,
  COND_VC,
  COND_VS
} from "./conditions.js";
import { CPSR_C, CPSR_N, CPSR_V, CPSR_Z } from "./registers.js";

function cpsr(flags: { n?: boolean; z?: boolean; c?: boolean; v?: boolean } = {}): number {
  let out = 0;
  if (flags.n) out |= CPSR_N;
  if (flags.z) out |= CPSR_Z;
  if (flags.c) out |= CPSR_C;
  if (flags.v) out |= CPSR_V;
  return out | 0;
}

describe("checkCondition — basic flag tests", () => {
  it("EQ / NE follow Z", () => {
    expect(checkCondition(COND_EQ, cpsr({ z: true }))).toBe(true);
    expect(checkCondition(COND_EQ, cpsr({ z: false }))).toBe(false);
    expect(checkCondition(COND_NE, cpsr({ z: true }))).toBe(false);
    expect(checkCondition(COND_NE, cpsr({ z: false }))).toBe(true);
  });

  it("CS / CC follow C", () => {
    expect(checkCondition(COND_CS, cpsr({ c: true }))).toBe(true);
    expect(checkCondition(COND_CC, cpsr({ c: true }))).toBe(false);
  });

  it("MI / PL follow N", () => {
    expect(checkCondition(COND_MI, cpsr({ n: true }))).toBe(true);
    expect(checkCondition(COND_PL, cpsr({ n: true }))).toBe(false);
  });

  it("VS / VC follow V", () => {
    expect(checkCondition(COND_VS, cpsr({ v: true }))).toBe(true);
    expect(checkCondition(COND_VC, cpsr({ v: true }))).toBe(false);
  });
});

describe("checkCondition — compound tests", () => {
  it("HI is C && !Z", () => {
    expect(checkCondition(COND_HI, cpsr({ c: true, z: false }))).toBe(true);
    expect(checkCondition(COND_HI, cpsr({ c: true, z: true }))).toBe(false);
    expect(checkCondition(COND_HI, cpsr({ c: false, z: false }))).toBe(false);
  });

  it("LS is !C || Z", () => {
    expect(checkCondition(COND_LS, cpsr({ c: false, z: false }))).toBe(true);
    expect(checkCondition(COND_LS, cpsr({ c: true, z: true }))).toBe(true);
    expect(checkCondition(COND_LS, cpsr({ c: true, z: false }))).toBe(false);
  });

  it("GE / LT compare N and V", () => {
    expect(checkCondition(COND_GE, cpsr({ n: true, v: true }))).toBe(true);
    expect(checkCondition(COND_GE, cpsr({ n: false, v: false }))).toBe(true);
    expect(checkCondition(COND_GE, cpsr({ n: true, v: false }))).toBe(false);
    expect(checkCondition(COND_LT, cpsr({ n: true, v: false }))).toBe(true);
    expect(checkCondition(COND_LT, cpsr({ n: true, v: true }))).toBe(false);
  });

  it("GT is !Z && (N == V)", () => {
    expect(checkCondition(COND_GT, cpsr({ z: false, n: true, v: true }))).toBe(true);
    expect(checkCondition(COND_GT, cpsr({ z: true, n: true, v: true }))).toBe(false);
    expect(checkCondition(COND_GT, cpsr({ z: false, n: true, v: false }))).toBe(false);
  });

  it("LE is Z || (N != V)", () => {
    expect(checkCondition(COND_LE, cpsr({ z: true }))).toBe(true);
    expect(checkCondition(COND_LE, cpsr({ z: false, n: true, v: false }))).toBe(true);
    expect(checkCondition(COND_LE, cpsr({ z: false, n: true, v: true }))).toBe(false);
  });
});

describe("checkCondition — AL / NV", () => {
  it("AL is always true regardless of flags", () => {
    expect(checkCondition(COND_AL, 0)).toBe(true);
    expect(checkCondition(COND_AL, cpsr({ n: true, z: true, c: true, v: true }))).toBe(true);
  });

  it("NV is always false on ARM7TDMI", () => {
    expect(checkCondition(COND_NV, cpsr({ n: true, z: true, c: true, v: true }))).toBe(false);
  });
});
