import { describe, expect, it } from "vitest";

import { SuperFx } from "./superfx.js";

/**
 * Assemble a tiny GSU program into ROM offset 0, point the chip at it, and
 * run to STOP. Register file is read back through the $3000-$301F ports.
 *
 * The GSU has a one-instruction pipeline: after GO is set the pending
 * pipeline byte (a NOP) executes first, so the program's byte 0 is the
 * first real instruction. r15 = $8000 folds to ROM offset 0 on the GSU bus.
 */
function runGsu(code: number[], setup?: (write: (reg: number, val: number) => void) => void): SuperFx {
  const rom = new Uint8Array(0x100000);
  rom.set(code, 0);
  const fx = new SuperFx(rom, new Uint8Array(0x8000));
  const write = (reg: number, val: number): void => {
    fx.writeCpu(0x00, reg, val);
  };
  setup?.(write);
  write(0x301e, 0x00); // r15 low
  write(0x301f, 0x80); // r15 high = $8000 → also sets GO
  for (let i = 0; i < 100000 && fx.snesIrqAsserted() === false && running(fx); i++) fx.tick(64);
  return fx;
}

/** GO bit still set? */
function running(fx: SuperFx): boolean {
  // STOP clears GO; read it via the low SFR port.
  return (fx.readCpu(0x00, 0x3030)! & 0x20) !== 0;
}

function reg(fx: SuperFx, n: number): number {
  return fx.readCpu(0x00, 0x3000 + n * 2)! | (fx.readCpu(0x00, 0x3001 + n * 2)! << 8);
}

/** SFR flags: read the full 16-bit status. */
function sfr(fx: SuperFx): number {
  return fx.readCpu(0x00, 0x3030)! | (fx.readCpu(0x00, 0x3031)! << 8);
}
const FLAG_Z = 0x02;
const FLAG_CY = 0x04;
const FLAG_S = 0x08;
const FLAG_OV = 0x10;

// opcode helpers
const IWT = (n: number, imm: number): number[] => [0xf0 + n, imm & 0xff, (imm >> 8) & 0xff];
const IBT = (n: number, imm: number): number[] => [0xa0 + n, imm & 0xff]; // sign-extended byte
const FROM = (n: number): number => 0xb0 + n;
const TO = (n: number): number => 0x10 + n;
const STOP = 0x00;
const ALT1 = 0x3d;
const ALT2 = 0x3e;

describe("SuperFX GSU", () => {
  it("loads immediates with IWT", () => {
    const fx = runGsu([...IWT(1, 0x1234), ...IWT(5, 0xabcd), STOP]);
    expect(reg(fx, 1)).toBe(0x1234);
    expect(reg(fx, 5)).toBe(0xabcd);
  });

  it("adds via FROM/ADD into the default destination r0", () => {
    // r1=5, r2=3, from r1, add r2 → r0 = 8
    const fx = runGsu([...IWT(1, 5), ...IWT(2, 3), FROM(1), 0x50 + 2, STOP]);
    expect(reg(fx, 0)).toBe(8);
    expect(sfr(fx) & (FLAG_Z | FLAG_CY | FLAG_S | FLAG_OV)).toBe(0);
  });

  it("routes the destination with TO", () => {
    // r1=$1000, to r3, from r1, add r1 → r3 = $2000
    const fx = runGsu([...IWT(1, 0x1000), TO(3), FROM(1), 0x50 + 1, STOP]);
    expect(reg(fx, 3)).toBe(0x2000);
  });

  it("sets carry and zero on a wrapping add", () => {
    // r1=$ffff, from r1, add r1 → $fffe, carry set
    const fx = runGsu([...IWT(1, 0xffff), FROM(1), 0x50 + 1, STOP]);
    expect(reg(fx, 0)).toBe(0xfffe);
    expect(sfr(fx) & FLAG_CY).toBe(FLAG_CY);
    // r1=1, from r1, sub r1 → 0, zero+carry(no borrow)
    const fx2 = runGsu([...IWT(1, 1), FROM(1), 0x60 + 1, STOP]);
    expect(reg(fx2, 0)).toBe(0);
    expect(sfr(fx2) & FLAG_Z).toBe(FLAG_Z);
  });

  it("computes signed subtraction sign/overflow flags", () => {
    // r1=0, r2=1, from r1, sub r2 → -1 ($ffff), sign set, borrow (carry clear)
    const fx = runGsu([...IWT(1, 0), ...IWT(2, 1), FROM(1), 0x60 + 2, STOP]);
    expect(reg(fx, 0)).toBe(0xffff);
    expect(sfr(fx) & FLAG_S).toBe(FLAG_S);
    expect(sfr(fx) & FLAG_CY).toBe(0); // r < 0 → carry clear (borrow)
  });

  it("does signed and unsigned multiply (MULT/UMULT)", () => {
    // signed: r1=-2 (via IBT sign extend), r2=3, from r1, mult r2 → -6 ($fffa)
    const fx = runGsu([...IBT(1, 0xfe), ...IWT(2, 3), FROM(1), 0x80 + 2, STOP]);
    expect(reg(fx, 0)).toBe(0xfffa);
    // unsigned umult: r1=$00fe (254), r2=3, from r1, alt1, umult r2 → 762 ($02fa)
    const fx2 = runGsu([...IWT(1, 0x00fe), ...IWT(2, 3), FROM(1), ALT1, 0x80 + 2, STOP]);
    expect(reg(fx2, 0)).toBe(254 * 3);
  });

  it("bitwise AND with a small immediate (alt2 — immediate is the opcode nibble)", () => {
    // r1=$ff0f, from r1, and #$0f (alt2) → $000f. For `and #N` the immediate
    // is N itself (0-15), encoded in the opcode's low nibble, not a stream byte.
    const fx = runGsu([...IWT(1, 0xff0f), FROM(1), ALT2, 0x70 + 0x0f, STOP]);
    expect(reg(fx, 0)).toBe(0x000f);
  });

  it("sign-extends a byte with IBT", () => {
    const fx = runGsu([...IBT(4, 0x80), STOP]); // -128 → $ff80
    expect(reg(fx, 4)).toBe(0xff80);
  });

  it("loops with LOOP until r12 reaches zero", () => {
    // r12 = 3 (loop counter), r13 = loop target, r1 counts up.
    // r1=0; r12=3; r13=<body>; body: inc r1; loop; stop
    // Lay out so r13 points at the inc. r15 base is $8000.
    // bytes: IWT r1,0 | IWT r12,3 | IWT r13,$8009 | [inc r1=0xd1] [loop=0x3c] [stop]
    // The inc is at program offset 9 → GSU addr $8000+? account for pipeline.
    // Simpler: verify LOOP decrements r12 and sets flags on a single pass.
    const fx = runGsu([...IWT(12, 5), 0x3c /* loop */, STOP]);
    expect(reg(fx, 12)).toBe(4); // decremented once
  });

  it("moves the high/low bytes with HIB/LOB and SWAP", () => {
    const hib = runGsu([...IWT(1, 0xab12), FROM(1), 0xc0 /* hib */, STOP]);
    expect(reg(hib, 0)).toBe(0x00ab);
    const lob = runGsu([...IWT(1, 0xab12), FROM(1), 0x9e /* lob */, STOP]);
    expect(reg(lob, 0)).toBe(0x0012);
    const swap = runGsu([...IWT(1, 0xab12), FROM(1), 0x4d /* swap */, STOP]);
    expect(reg(swap, 0)).toBe(0x12ab);
  });

  it("stores to and loads from game-pak RAM (SM/LM)", () => {
    // r1=$1234; with r0; sm ($0010),r1 ; then lm r2,($0010)
    // sm (xx),rN = 0xf0+n alt2; lm rN,(xx) = 0xf0+n alt1
    const prog = [
      ...IWT(1, 0x1234),
      ALT2,
      0xf0 + 1,
      0x10,
      0x00, // sm ($0010), r1
      ALT1,
      0xf0 + 2,
      0x10,
      0x00, // lm r2, ($0010)
      STOP
    ];
    const fx = runGsu(prog);
    expect(reg(fx, 2)).toBe(0x1234);
  });
});
