import { describe, expect, it } from "vitest";

import { Cpu65816 } from "./cpu.js";

/** Flat 16 MiB RAM bus — every access lands somewhere readable back. */
function makeCpu(program: number[], native = false): { cpu: Cpu65816; mem: Uint8Array } {
  const mem = new Uint8Array(0x1000000);
  mem.set(program, 0x8000);
  const cpu = new Cpu65816({
    cost: () => 6, // flat-speed test bus; region costs are the real bus's job
    read: (a) => mem[a]!,
    write: (a, v) => {
      mem[a] = v;
    }
  });
  cpu.pc = 0x8000;
  cpu.s = 0x01ff;
  if (native) {
    cpu.e = 0;
    cpu.p = 0; // 16-bit accumulator and indexes
  }
  return { cpu, mem };
}

describe("Cpu65816", () => {
  it("runs 8-bit immediate loads with N/Z flags in emulation mode", () => {
    const { cpu } = makeCpu([0xa9, 0x80]); // LDA #$80
    cpu.step();
    expect(cpu.a & 0xff).toBe(0x80);
    expect(cpu.p & 0x80).toBe(0x80); // N
    expect(cpu.cycles).toBe(2 * 6);
  });

  it("runs 16-bit loads when M is clear, preserving nothing but flags", () => {
    const { cpu } = makeCpu([0xa9, 0x34, 0x12], true); // LDA #$1234
    cpu.step();
    expect(cpu.a).toBe(0x1234);
    expect(cpu.cycles).toBe(3 * 6);
  });

  it("preserves the B accumulator byte across 8-bit operations", () => {
    const { cpu } = makeCpu([0xe2, 0x20, 0xa9, 0x55], true); // SEP #$20; LDA #$55
    cpu.a = 0xab00;
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0xab55);
  });

  it("truncates the index registers when SEP sets the X flag", () => {
    const { cpu } = makeCpu([0xe2, 0x10], true); // SEP #$10
    cpu.x = 0x1234;
    cpu.y = 0x5678;
    cpu.step();
    expect(cpu.x).toBe(0x34);
    expect(cpu.y).toBe(0x78);
  });

  it("adds BCD with the decimal flag, including the 16-bit widths", () => {
    // SED; CLC; LDA #$1599; ADC #$0501  (BCD: 1599 + 0501 = 2100)
    const { cpu } = makeCpu([0xf8, 0x18, 0xa9, 0x99, 0x15, 0x69, 0x01, 0x05], true);
    for (let i = 0; i < 4; i++) cpu.step();
    expect(cpu.a).toBe(0x2100);
    expect(cpu.p & 0x01).toBe(0); // no carry
  });

  it("XCE swaps carry and emulation, forcing the E-mode invariants", () => {
    const { cpu } = makeCpu([0x18, 0xfb], false); // CLC; XCE -> native
    cpu.step();
    cpu.step();
    expect(cpu.e).toBe(0);
    expect(cpu.p & 0x01).toBe(0x01); // old E landed in carry
    expect(cpu.p & 0x30).toBe(0x30); // M/X stay set until REP
  });

  it("JSL/RTL round-trip across banks", () => {
    const { cpu, mem } = makeCpu([0x22, 0x00, 0x90, 0x12]); // JSL $129000
    mem[0x129000] = 0x6b; // RTL
    cpu.step();
    expect(cpu.pbr).toBe(0x12);
    expect(cpu.pc).toBe(0x9000);
    cpu.step();
    expect(cpu.pbr).toBe(0x00);
    expect(cpu.pc).toBe(0x8004);
  });

  it("pushes into page 0 for 65816-new stack ops in emulation mode", () => {
    const { cpu, mem } = makeCpu([0xf4, 0xcd, 0xab]); // PEA #$ABCD
    cpu.s = 0x0100;
    cpu.step();
    expect(mem[0x0100]).toBe(0xab);
    expect(mem[0x00ff]).toBe(0xcd); // crossed below page 1
    expect(cpu.s).toBe(0x01fe); // pin re-applied
  });

  it("wraps old-style pushes within page 1 in emulation mode", () => {
    const { cpu, mem } = makeCpu([0x48]); // PHA
    cpu.a = 0x42;
    cpu.s = 0x0100;
    cpu.step();
    expect(mem[0x0100]).toBe(0x42);
    expect(cpu.s).toBe(0x01ff);
  });

  it("MVN moves one byte per step and rewinds PC until the count expires", () => {
    const { cpu, mem } = makeCpu([0x54, 0x01, 0x00], true); // MVN $00 -> $01
    cpu.a = 1; // two bytes
    cpu.x = 0x2000;
    cpu.y = 0x3000;
    mem[0x2000] = 0xaa;
    mem[0x2001] = 0xbb;
    cpu.step();
    expect(mem[0x013000]).toBe(0xaa);
    expect(cpu.pc).toBe(0x8000); // rewound
    expect(cpu.cycles).toBe(7 * 6);
    cpu.step();
    expect(mem[0x013001]).toBe(0xbb);
    expect(cpu.pc).toBe(0x8003); // done
    expect(cpu.a).toBe(0xffff);
    expect(cpu.dbr).toBe(0x01);
  });

  it("services hardware interrupts through the native vector with PBR push", () => {
    const { cpu, mem } = makeCpu([0xea], true); // NOP
    cpu.pbr = 0x12;
    cpu.pc = 0x8000;
    mem[0xffea] = 0x00;
    mem[0xffeb] = 0x90;
    cpu.hwInterrupt(0xffea);
    expect(cpu.pbr).toBe(0);
    expect(cpu.pc).toBe(0x9000);
    expect(mem[0x01ff]).toBe(0x12); // pushed PBR
    expect(cpu.irqDisabled).toBe(true);
  });

  it("wakes from WAI on a hardware interrupt", () => {
    const { cpu, mem } = makeCpu([0xcb, 0xea]); // WAI; NOP
    mem[0xfffa] = 0x00;
    mem[0xfffb] = 0x90;
    cpu.step();
    expect(cpu.waiting).toBe(true);
    const idleCycles = cpu.cycles;
    cpu.step(); // halted — burns a cycle, no fetch
    expect(cpu.cycles).toBe(idleCycles + 6);
    cpu.hwInterrupt(0xfffa);
    expect(cpu.waiting).toBe(false);
    expect(cpu.pc).toBe(0x9000);
  });

  it("BRK vectors differ between emulation and native mode", () => {
    const emu = makeCpu([0x00, 0x00]);
    emu.mem[0xfffe] = 0x00;
    emu.mem[0xffff] = 0x91;
    emu.cpu.step();
    expect(emu.cpu.pc).toBe(0x9100);

    const nat = makeCpu([0x00, 0x00], true);
    nat.mem[0xffe6] = 0x00;
    nat.mem[0xffe7] = 0x92;
    nat.cpu.step();
    expect(nat.cpu.pc).toBe(0x9200);
  });

  it("direct-page addressing pays the extra cycle only when DL is set", () => {
    const a = makeCpu([0xa5, 0x10]); // LDA $10
    a.cpu.step();
    expect(a.cpu.cycles).toBe(3 * 6);
    const b = makeCpu([0xa5, 0x10]);
    b.cpu.d = 0x0001;
    b.cpu.step();
    expect(b.cpu.cycles).toBe(4 * 6);
  });

  it("wraps E-mode pointer fetches within the page for (dp) and (dp,X)", () => {
    // (dp): pointer at $FF wraps to $00 for its high byte.
    const a = makeCpu([0xb2, 0xff]); // LDA ($FF)
    a.mem[0x00ff] = 0x34;
    a.mem[0x0000] = 0x12;
    a.mem[0x1234] = 0x99;
    a.cpu.step();
    expect(a.cpu.a & 0xff).toBe(0x99);

    // (dp,X) DL=0: high byte of the pointer wraps to the page start
    // (hardware-verified by gilyon cputest-full 0024; the SingleStepTests
    // vectors read $0100 here and lose to silicon).
    const b = makeCpu([0xa1, 0xfe]); // LDA ($FE,X)
    b.cpu.x = 0x01;
    b.mem[0x00ff] = 0x78;
    b.mem[0x0000] = 0x56;
    b.mem[0x5678] = 0x77;
    b.cpu.step();
    expect(b.cpu.a & 0xff).toBe(0x77);

    // (dp,X) DL!=0 (gilyon 0027 shape): full-width index add, then the +1
    // for the high byte still wraps within the page.
    const c = makeCpu([0xa1, 0xf7]); // LDA ($F7,X)
    c.cpu.d = 0x011a;
    c.cpu.x = 0xee;
    c.mem[0x02ff] = 0x34; // D+dp+X = $02FF
    c.mem[0x0200] = 0x12; // high byte wraps to $0200, not $0300
    c.mem[0x1234] = 0x42;
    c.cpu.step();
    expect(c.cpu.a & 0xff).toBe(0x42);
  });
});
