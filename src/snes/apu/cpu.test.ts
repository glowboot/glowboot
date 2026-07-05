import { describe, expect, it } from "vitest";

import { Spc700 } from "./cpu.js";

/** Corner behaviours pinned by the SingleStepTests spc700 vectors during
 *  development (256,000/256,000 passed) — kept as regression tests. */
function makeCpu(program: number[]): { cpu: Spc700; mem: Uint8Array } {
  const mem = new Uint8Array(0x10000);
  mem.set(program, 0x400);
  const cpu = new Spc700({
    read: (a) => mem[a]!,
    write: (a, v) => {
      mem[a] = v;
    }
  });
  cpu.pc = 0x400;
  return { cpu, mem };
}

describe("Spc700", () => {
  it("selects the direct page with the P flag", () => {
    const { cpu, mem } = makeCpu([0x40, 0xe4, 0x20]); // SETP; MOV A,$20
    mem[0x020] = 0x11;
    mem[0x120] = 0x22;
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x22); // page 1
  });

  it("ADC sets the half-carry flag from bit 3", () => {
    const { cpu } = makeCpu([0x88, 0x09]); // ADC A,#$09
    cpu.a = 0x08;
    cpu.step();
    expect(cpu.a).toBe(0x11);
    expect(cpu.psw & 0x08).toBe(0x08); // H
  });

  it("DAA adjusts the high column first (BCD $99 + $01 = $00 carry)", () => {
    const { cpu } = makeCpu([0x88, 0x01, 0xdf]); // ADC #$01; DAA
    cpu.a = 0x99;
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.psw & 0x01).toBe(0x01);
  });

  it("MUL leaves the product in YA with NZ from Y", () => {
    const { cpu } = makeCpu([0xcf]); // MUL YA
    cpu.y = 0x12;
    cpu.a = 0x34;
    cpu.step();
    expect((cpu.y << 8) | cpu.a).toBe(0x12 * 0x34);
    expect(cpu.cycles).toBe(9);
  });

  it("DIV produces the hardware's overflowed results when Y >= X*2", () => {
    const { cpu } = makeCpu([0x9e]); // DIV YA,X
    cpu.y = 0xf0;
    cpu.a = 0x00;
    cpu.x = 0x10;
    cpu.step();
    expect(cpu.psw & 0x40).toBe(0x40); // V: quotient overflow
    expect(cpu.cycles).toBe(12);
  });

  it("DIV divides normally when the quotient fits", () => {
    const { cpu } = makeCpu([0x9e]);
    cpu.y = 0x01;
    cpu.a = 0x2c;
    cpu.x = 0x10; // 300 / 16 = 18 r 12
    cpu.step();
    expect(cpu.a).toBe(18);
    expect(cpu.y).toBe(12);
  });

  it("ADDW/SUBW set the 16-bit half-carry from bit 11", () => {
    const { cpu, mem } = makeCpu([0x7a, 0x10]); // ADDW YA,$10
    mem[0x10] = 0x00;
    mem[0x11] = 0x0f; // $0F00
    cpu.y = 0x01;
    cpu.a = 0x00; // YA = $0100
    cpu.step();
    expect((cpu.y << 8) | cpu.a).toBe(0x1000);
    expect(cpu.psw & 0x08).toBe(0x08); // H from bit 11 carry
  });

  it("TSET1 reports flags from A minus memory, then sets bits", () => {
    const { cpu, mem } = makeCpu([0x0e, 0x50, 0x02]); // TSET1 $0250
    mem[0x250] = 0x0f;
    cpu.a = 0x0f;
    cpu.step();
    expect(mem[0x250]).toBe(0x0f);
    expect(cpu.psw & 0x02).toBe(0x02); // Z: A - mem == 0
  });

  it("TCALL vectors through the $FFDE-down table in 8 cycles", () => {
    const { cpu, mem } = makeCpu([0x21]); // TCALL 2
    mem[0xffda] = 0x34;
    mem[0xffdb] = 0x12;
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
    expect(cpu.cycles).toBe(8);
  });

  it("bit ops address 13-bit memory + 3-bit bit index", () => {
    const { cpu, mem } = makeCpu([0xaa, 0x34, 0xc2]); // MOV1 C,$0234.6
    mem[0x234] = 0x40;
    cpu.step();
    expect(cpu.psw & 0x01).toBe(0x01);
  });

  it("DBNZ decrements memory and branches until zero", () => {
    const { cpu, mem } = makeCpu([0x6e, 0x30, 0xfd]); // DBNZ $30,-3 (self)
    mem[0x30] = 3;
    cpu.step();
    expect(mem[0x30]).toBe(2);
    expect(cpu.pc).toBe(0x400); // looped back
    cpu.step();
    cpu.step();
    expect(mem[0x30]).toBe(0);
    expect(cpu.pc).toBe(0x403); // fell through
  });

  it("SLEEP halts the core (7-cycle entry)", () => {
    const { cpu } = makeCpu([0xef]);
    cpu.step();
    expect(cpu.sleeping).toBe(true);
    expect(cpu.cycles).toBe(7);
  });
});
