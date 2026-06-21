import { describe, expect, it } from "vitest";

import { InterruptController, IRQ_VBLANK } from "../memory/interrupts.js";
import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import { dispatchSwi } from "./bios-hle.js";
import { ArmCpu } from "./cpu.js";
import { CPSR_I, MODE_SYS } from "./registers.js";

function makeFixture(): {
  cpu: ArmCpu;
  ic: InterruptController;
  mem: ReturnType<typeof makeGbaMemoryMap>;
} {
  const mem = makeGbaMemoryMap();
  const cpu = new ArmCpu(mem.bus, 0x08000000);
  cpu.interrupts = mem.interrupts;
  cpu.regs.setMode(MODE_SYS);
  cpu.regs.cpsr &= ~CPSR_I;
  cpu.regs.r[13] = 0x03007f00;
  return { cpu, ic: mem.interrupts, mem };
}

describe("BIOS HLE — dispatcher fallthrough", () => {
  it("returns false for an unimplemented SWI", () => {
    const { cpu, ic } = makeFixture();
    expect(dispatchSwi(0xff, cpu.regs, cpu.bus, cpu, ic)).toBe(false);
  });
});

describe("BIOS HLE — Div (0x06) and DivArm (0x07)", () => {
  it("returns quotient, remainder, and abs(quotient) for positive operands", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 17;
    cpu.regs.r[1] = 5;
    expect(dispatchSwi(0x06, cpu.regs, cpu.bus, cpu, ic)).toBe(true);
    expect(cpu.regs.r[0]).toBe(3);
    expect(cpu.regs.r[1]).toBe(2);
    expect(cpu.regs.r[3]).toBe(3);
  });

  it("truncates toward zero for negative numerator", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = -17;
    cpu.regs.r[1] = 5;
    dispatchSwi(0x06, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(-3);
    expect(cpu.regs.r[1]).toBe(-2);
    expect(cpu.regs.r[3]).toBe(3);
  });

  it("handles division by zero with sign-of-numerator convention", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = -42;
    cpu.regs.r[1] = 0;
    dispatchSwi(0x06, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(-1);
    expect(cpu.regs.r[1]).toBe(-42);
    // r3 = 1 on divide-by-zero — real-BIOS behaviour pinned by
    // mgba-suite bios-math's "Div by zero" rows.
    expect(cpu.regs.r[3]).toBe(1);
  });

  it("DivArm swaps the operand order (r0=den, r1=num)", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 5;
    cpu.regs.r[1] = 17;
    dispatchSwi(0x07, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(3);
    expect(cpu.regs.r[1]).toBe(2);
  });
});

describe("BIOS HLE — Sqrt (0x08)", () => {
  it("returns floor(sqrt(r0))", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 100;
    dispatchSwi(0x08, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(10);
    cpu.regs.r[0] = 99;
    dispatchSwi(0x08, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(9);
  });

  it("treats r0 as unsigned 32-bit", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = -1; // 0xFFFFFFFF unsigned = 4294967295
    dispatchSwi(0x08, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(0xffff);
  });
});

describe("BIOS HLE — ArcTan (0x09) and ArcTan2 (0x0A)", () => {
  it("ArcTan(0) = 0", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 0;
    dispatchSwi(0x09, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(0);
  });

  it("ArcTan(1.0) ≈ pi/4 → ~0x2000 in Q1.14 (pi/2 = 0x4000)", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 0x4000; // 1.0 in Q1.14
    dispatchSwi(0x09, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(0x2000);
  });

  it("ArcTan2(+x, 0) = 0", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 100;
    cpu.regs.r[1] = 0;
    dispatchSwi(0x0a, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(0);
  });

  it("ArcTan2(0, +y) = 0x4000 (pi/2)", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 0;
    cpu.regs.r[1] = 100;
    dispatchSwi(0x0a, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(0x4000);
  });

  it("ArcTan2(-x, 0) = 0x8000 (pi)", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = -100;
    cpu.regs.r[1] = 0;
    dispatchSwi(0x0a, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.regs.r[0]).toBe(0x8000);
  });
});

describe("BIOS HLE — CpuSet (0x0B)", () => {
  it("copies halfwords when bit 26 is clear", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    for (let i = 0; i < 4; i++) mem.bus.write16(src + i * 2, 0x1000 + i);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = 4; // count, no flags
    dispatchSwi(0x0b, cpu.regs, cpu.bus, cpu, ic);
    for (let i = 0; i < 4; i++) {
      expect(mem.bus.read16(dst + i * 2)).toBe(0x1000 + i);
    }
  });

  it("copies words when bit 26 is set", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    for (let i = 0; i < 4; i++) mem.bus.write32(src + i * 4, 0xdeadbe00 + i);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = 4 | (1 << 26);
    dispatchSwi(0x0b, cpu.regs, cpu.bus, cpu, ic);
    for (let i = 0; i < 4; i++) {
      expect(mem.bus.read32(dst + i * 4) >>> 0).toBe((0xdeadbe00 + i) >>> 0);
    }
  });

  it("fills when bit 24 is set — reads src once, writes count times", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    mem.bus.write32(src, 0xabcd1234);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = 5 | (1 << 24) | (1 << 26); // word + fill
    dispatchSwi(0x0b, cpu.regs, cpu.bus, cpu, ic);
    for (let i = 0; i < 5; i++) {
      expect(mem.bus.read32(dst + i * 4) >>> 0).toBe(0xabcd1234);
    }
  });
});

describe("BIOS HLE — CpuFastSet (0x0C)", () => {
  it("rounds count up to a multiple of 8 and copies 32-bit words", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    for (let i = 0; i < 16; i++) mem.bus.write32(src + i * 4, 0x55550000 + i);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = 5; // rounded up to 8
    dispatchSwi(0x0c, cpu.regs, cpu.bus, cpu, ic);
    for (let i = 0; i < 8; i++) {
      expect(mem.bus.read32(dst + i * 4) >>> 0).toBe((0x55550000 + i) >>> 0);
    }
  });

  it("supports fill (bit 24)", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    mem.bus.write32(src, 0xcafebabe);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = 8 | (1 << 24);
    dispatchSwi(0x0c, cpu.regs, cpu.bus, cpu, ic);
    for (let i = 0; i < 8; i++) {
      expect(mem.bus.read32(dst + i * 4) >>> 0).toBe(0xcafebabe);
    }
  });
});

describe("BIOS HLE — Halt (0x02)", () => {
  it("sets cpu.halted with intrWaitMask = 0", () => {
    const { cpu, ic } = makeFixture();
    dispatchSwi(0x02, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.halted).toBe(true);
    expect(cpu.intrWaitMask).toBe(0);
  });

  it("plain Halt releases when any enabled+pending IRQ fires (CPSR.I ignored)", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.cpsr |= CPSR_I; // Halt ignores the mask
    // A wakeable halt (IME on + an enabled source) parks until the IF bit fires.
    ic.ime = 1;
    ic.ie = 1 << IRQ_VBLANK;
    dispatchSwi(0x02, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.halted).toBe(true);
    // No IRQ pending yet: step is a no-op, halt stays set.
    cpu.step();
    expect(cpu.halted).toBe(true);
    // Raise the enabled VBlank IRQ.
    ic.raise(IRQ_VBLANK);
    cpu.step();
    expect(cpu.halted).toBe(false);
  });

  it("plain Halt that no IRQ can wake (IME=0) resumes immediately", () => {
    const { cpu, ic } = makeFixture();
    ic.ime = 0; // master enable off — no IRQ could ever release this halt
    ic.ie = 1 << IRQ_VBLANK;
    dispatchSwi(0x02, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.halted).toBe(true);
    // Real hardware resumes such a halt at once rather than hang.
    cpu.step();
    expect(cpu.halted).toBe(false);
  });
});

describe("BIOS HLE — IntrWait (0x04) and VBlankIntrWait (0x05)", () => {
  it("IntrWait halts and parks the wait mask on the CPU", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 0; // don't clear flag first
    cpu.regs.r[1] = 1 << IRQ_VBLANK;
    dispatchSwi(0x04, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.halted).toBe(true);
    expect(cpu.intrWaitMask).toBe(1 << IRQ_VBLANK);
  });

  it("IntrWait with clearFirst=1 clears the matching bits in the BIOS interrupt-check flag", () => {
    const { cpu, ic, mem } = makeFixture();
    mem.bus.write16(0x03007ff8, 0xffff);
    cpu.regs.r[0] = 1;
    cpu.regs.r[1] = 1 << IRQ_VBLANK;
    dispatchSwi(0x04, cpu.regs, cpu.bus, cpu, ic);
    expect(mem.bus.read16(0x03007ff8) & 0xffff).toBe(0xffff & ~(1 << IRQ_VBLANK));
  });

  it("IntrWait releases when the BIOS flag at 0x03007FF8 picks up the waited bit", () => {
    const { cpu, ic, mem } = makeFixture();
    cpu.regs.r[0] = 1;
    cpu.regs.r[1] = 1 << IRQ_VBLANK;
    dispatchSwi(0x04, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.halted).toBe(true);
    // Step with the flag still clear → stays halted.
    cpu.step();
    expect(cpu.halted).toBe(true);
    // Simulate the user IRQ handler ORing the consumed IF bit into the
    // BIOS interrupt-check flag.
    const cur = mem.bus.read16(0x03007ff8) & 0xffff;
    mem.bus.write16(0x03007ff8, cur | (1 << IRQ_VBLANK));
    cpu.step();
    expect(cpu.halted).toBe(false);
    expect(cpu.intrWaitMask).toBe(0);
    // The serviced bit is also cleared so the next IntrWait re-waits.
    expect(mem.bus.read16(0x03007ff8) & (1 << IRQ_VBLANK)).toBe(0);
    void ic;
  });

  it("VBlankIntrWait is shorthand for IntrWait(1, 1)", () => {
    const { cpu, ic } = makeFixture();
    cpu.regs.r[0] = 0;
    cpu.regs.r[1] = 0;
    dispatchSwi(0x05, cpu.regs, cpu.bus, cpu, ic);
    expect(cpu.halted).toBe(true);
    expect(cpu.intrWaitMask).toBe(1 << IRQ_VBLANK);
  });
});

describe("BIOS HLE — ObjAffineSet (0x0F)", () => {
  it("writes pa/pb/pc/pd at multiples of `stride` from dst", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    // scale_x = 0x100 (1.0), scale_y = 0x100, angle = 0 (no rotation)
    mem.bus.write16(src, 0x100);
    mem.bus.write16(src + 2, 0x100);
    mem.bus.write16(src + 4, 0);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = 1; // count
    cpu.regs.r[3] = 8; // stride (packed PA/PB/PC/PD)
    dispatchSwi(0x0f, cpu.regs, cpu.bus, cpu, ic);
    // At angle=0, scale=1.0 → pa=1.0, pb=0, pc=0, pd=1.0 in Q7.8.
    const sx = (mem.bus.read16(dst) << 16) >> 16;
    const sx2 = (mem.bus.read16(dst + 8 * 3) << 16) >> 16;
    expect(sx).toBe(0x100);
    expect((mem.bus.read16(dst + 8) << 16) >> 16).toBe(0);
    expect((mem.bus.read16(dst + 16) << 16) >> 16).toBe(0);
    expect(sx2).toBe(0x100);
  });
});

describe("BIOS HLE — BgAffineSet (0x0E)", () => {
  it("at angle=0, scale=1.0 → identity matrix, ref point = origin", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    const originX = 0x4000_00; // Q19.8 representation of 0x4000 (arbitrary)
    const originY = 0x2000_00;
    mem.bus.write32(src, originX);
    mem.bus.write32(src + 4, originY);
    mem.bus.write16(src + 8, 0); // disp_x
    mem.bus.write16(src + 10, 0); // disp_y
    mem.bus.write16(src + 12, 0x100); // scale_x = 1.0
    mem.bus.write16(src + 14, 0x100); // scale_y = 1.0
    mem.bus.write16(src + 16, 0); // angle = 0
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = 1;
    dispatchSwi(0x0e, cpu.regs, cpu.bus, cpu, ic);
    expect((mem.bus.read16(dst) << 16) >> 16).toBe(0x100); // pa
    expect((mem.bus.read16(dst + 2) << 16) >> 16).toBe(0); // pb
    expect((mem.bus.read16(dst + 4) << 16) >> 16).toBe(0); // pc
    expect((mem.bus.read16(dst + 6) << 16) >> 16).toBe(0x100); // pd
    expect(mem.bus.read32(dst + 8) | 0).toBe(originX | 0);
    expect(mem.bus.read32(dst + 12) | 0).toBe(originY | 0);
  });
});

function loadBytes(bus: ReturnType<typeof makeGbaMemoryMap>["bus"], addr: number, bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) bus.write8(addr + i, bytes[i]! & 0xff);
}

function readBytes(bus: ReturnType<typeof makeGbaMemoryMap>["bus"], addr: number, length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) out.push(bus.read8(addr + i) & 0xff);
  return out;
}

describe("BIOS HLE — BitUnPack (0x10)", () => {
  it("expands 1bpp → 4bpp with offset 1, zero bits stay 0 (the classic font-inflate)", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    const info = 0x02002000;
    // Source: one byte 0xA5 = 10100101 → bits LSB-first: 1,0,1,0,0,1,0,1.
    mem.bus.write8(src, 0xa5);
    // info: srcLen=1, srcWidth=1, dstWidth=4, offset=1, zeroFlag=0.
    mem.bus.write16(info, 1);
    mem.bus.write8(info + 2, 1);
    mem.bus.write8(info + 3, 4);
    mem.bus.write32(info + 4, 1);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = info;
    dispatchSwi(0x10, cpu.regs, cpu.bus, cpu, ic);
    // Per GBATEK the offset is added to NON-zero source units, so
    // each "1" bit becomes 1+offset=2 in its 4-bit slot; zero bits
    // stay 0 (zero-flag not set). Source bits LSB-first: 1,0,1,0,0,1,0,1
    // → slot0=2,slot1=0,slot2=2,slot3=0,slot4=0,slot5=2,slot6=0,slot7=2
    // → packed LSB-first as nibbles → 0x20200202.
    expect(mem.bus.read32(dst) >>> 0).toBe(0x20200202);
  });

  it("zero-flag set: zero source units also get the offset applied", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    const info = 0x02002000;
    mem.bus.write8(src, 0x00); // all zeros
    mem.bus.write16(info, 1);
    mem.bus.write8(info + 2, 1);
    mem.bus.write8(info + 3, 4);
    // offset=5, zero-flag set (bit 31).
    mem.bus.write32(info + 4, 5 | 0x80000000);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = info;
    dispatchSwi(0x10, cpu.regs, cpu.bus, cpu, ic);
    // All 8 source bits = 0; each becomes 0 + 5 = 5 in a 4-bit slot.
    expect(mem.bus.read32(dst) >>> 0).toBe(0x55555555);
  });

  it("2bpp → 8bpp with offset 0x10", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    const info = 0x02002000;
    // Source byte 0xE4 = 11_10_01_00 → LSB-first units: 0, 1, 2, 3.
    mem.bus.write8(src, 0xe4);
    mem.bus.write16(info, 1);
    mem.bus.write8(info + 2, 2);
    mem.bus.write8(info + 3, 8);
    mem.bus.write32(info + 4, 0x10);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = info;
    dispatchSwi(0x10, cpu.regs, cpu.bus, cpu, ic);
    // Outputs: 0 (zero, no flag), 1+0x10=0x11, 2+0x10=0x12, 3+0x10=0x13.
    // 4 × 8-bit slots packed LSB-first in one 32-bit word.
    expect(mem.bus.read32(dst) >>> 0).toBe((0x13 << 24) | (0x12 << 16) | (0x11 << 8) | 0x00);
  });

  it("flushes a trailing partial word at end of source", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    const info = 0x02002000;
    // Source: one byte 0xFF, expanded 1bpp → 32bpp would need 8 dst
    // words. Use srcWidth=8/dstWidth=32 instead so we get one dst slot
    // (32 bits) per source byte and exercise the no-trailing-padding
    // path with a single source byte and offset 0x100.
    mem.bus.write8(src, 0x42);
    mem.bus.write16(info, 1);
    mem.bus.write8(info + 2, 8);
    mem.bus.write8(info + 3, 32);
    mem.bus.write32(info + 4, 0x100);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    cpu.regs.r[2] = info;
    dispatchSwi(0x10, cpu.regs, cpu.bus, cpu, ic);
    expect(mem.bus.read32(dst) >>> 0).toBe(0x142);
  });
});

describe("BIOS HLE — LZ77UnComp (0x11 Wram / 0x12 Vram)", () => {
  it("decompresses 'ABCABCABC' via 1 literal-run + 1 back-reference", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    // Header: type=1 (LZ77 nibble = 0x1), size=9 bytes.
    // header word = size << 8 | (type << 4) = 0x0910.
    mem.bus.write32(src, 0x00000910);
    // Flag byte = 0b0001_0000 — three literals, one match, then EOS.
    // The match: len=6, dist=3 → b0=(6-3)<<4 | ((3-1)>>8)=0x30, b1=(3-1)&0xff=0x02.
    loadBytes(mem.bus, src + 4, [0x10, 0x41, 0x42, 0x43, 0x30, 0x02]);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    dispatchSwi(0x11, cpu.regs, cpu.bus, cpu, ic);
    expect(readBytes(mem.bus, dst, 9)).toEqual([0x41, 0x42, 0x43, 0x41, 0x42, 0x43, 0x41, 0x42, 0x43]);
  });

  it("Vram variant writes through 16-bit halfwords (same logical output)", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x06000000; // VRAM
    mem.bus.write32(src, 0x00000a10); // size = 10 bytes
    // Five literals, then a 5-byte match referencing the literals.
    // Flag byte = 0b00000_100 = 0x04 (five 0-bits, then one 1-bit).
    loadBytes(mem.bus, src + 4, [0x04, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0x20, 0x04]);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    dispatchSwi(0x12, cpu.regs, cpu.bus, cpu, ic);
    expect(readBytes(mem.bus, dst, 10)).toEqual([0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0]);
  });
});

describe("BIOS HLE — RLUnComp (0x14 Wram / 0x15 Vram)", () => {
  it("decompresses a run-of-5 followed by a literal triple", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    mem.bus.write32(src, 0x00000830); // size = 8 bytes
    // Run flag: bit 7 = 1, length = (flag & 0x7F) + 3 → for length 5, flag = 0x82.
    // Literal flag: bit 7 = 0, length = (flag & 0x7F) + 1 → for length 3, flag = 0x02.
    loadBytes(mem.bus, src + 4, [0x82, 0x41, 0x02, 0x42, 0x43, 0x44]);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    dispatchSwi(0x14, cpu.regs, cpu.bus, cpu, ic);
    expect(readBytes(mem.bus, dst, 8)).toEqual([0x41, 0x41, 0x41, 0x41, 0x41, 0x42, 0x43, 0x44]);
  });

  it("Vram variant produces the same output through halfword writes", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x06000000;
    mem.bus.write32(src, 0x00000430); // size = 4 bytes
    loadBytes(mem.bus, src + 4, [0x81, 0x55]); // run of 4 0x55s
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    dispatchSwi(0x15, cpu.regs, cpu.bus, cpu, ic);
    expect(readBytes(mem.bus, dst, 4)).toEqual([0x55, 0x55, 0x55, 0x55]);
  });
});

describe("BIOS HLE — Diff8bitUnFilter (0x16 / 0x17)", () => {
  it("integrates byte-deltas back to the original sequence", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    // Decompressed: [10, 13, 12, 20, 200, 0]
    // Encoded deltas: out[0]=10, then +3, -1, +8, +180, +56.
    mem.bus.write32(src, 0x00000681); // size = 6 bytes, type 8, data=1
    loadBytes(mem.bus, src + 4, [10, 3, 0xff, 8, 180, 56]);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    dispatchSwi(0x16, cpu.regs, cpu.bus, cpu, ic);
    expect(readBytes(mem.bus, dst, 6)).toEqual([10, 13, 12, 20, 200, 0]);
  });
});

describe("BIOS HLE — Diff16bitUnFilter (0x18)", () => {
  it("integrates halfword-deltas back to the original sequence", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    // Decompressed halfwords: [0x1000, 0x1005, 0x0FF5, 0x2000]
    // Deltas: 0x1000, +5, -16, +0x100B.
    mem.bus.write32(src, 0x00000882); // size = 8 bytes (4 halfwords), type 8, data=2
    mem.bus.write16(src + 4, 0x1000);
    mem.bus.write16(src + 6, 0x0005);
    mem.bus.write16(src + 8, 0xfff0); // -16 mod 0x10000
    mem.bus.write16(src + 10, 0x100b);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    dispatchSwi(0x18, cpu.regs, cpu.bus, cpu, ic);
    expect(mem.bus.read16(dst) & 0xffff).toBe(0x1000);
    expect(mem.bus.read16(dst + 2) & 0xffff).toBe(0x1005);
    expect(mem.bus.read16(dst + 4) & 0xffff).toBe(0x0ff5);
    expect(mem.bus.read16(dst + 6) & 0xffff).toBe(0x2000);
  });
});

describe("BIOS HLE — HuffUnComp (0x13)", () => {
  it("decompresses 'ABBA' with a minimal 2-symbol tree (8-bit symbols)", () => {
    const { cpu, ic, mem } = makeFixture();
    const src = 0x02000000;
    const dst = 0x02001000;
    // Header: data size 8, type 2, size 4 → 0x00000428.
    mem.bus.write32(src, 0x00000428);
    // Tree: size byte = 1 (2 halfwords), root data = 0xC0 (offset 0,
    // both children are leaves), left leaf = 'A' (0x41), right = 'B'.
    loadBytes(mem.bus, src + 4, [0x01, 0xc0, 0x41, 0x42]);
    // Bitstream: 0,1,1,0 → A,B,B,A. MSB first in 32-bit LE word →
    // 0x60000000 stored LE as [0x00, 0x00, 0x00, 0x60].
    loadBytes(mem.bus, src + 8, [0x00, 0x00, 0x00, 0x60]);
    cpu.regs.r[0] = src;
    cpu.regs.r[1] = dst;
    dispatchSwi(0x13, cpu.regs, cpu.bus, cpu, ic);
    expect(readBytes(mem.bus, dst, 4)).toEqual([0x41, 0x42, 0x42, 0x41]);
  });
});

describe("BIOS HLE — SWI integration through stepArm", () => {
  it("ARM SWI #0x060000 dispatches Div without entering SVC mode", () => {
    const { cpu, mem } = makeFixture();
    const code = 0x02000000;
    cpu.regs.r[15] = code;
    cpu.regs.r[0] = 100;
    cpu.regs.r[1] = 7;
    // ARM `swi #0x060000` = 0xEF060000 (cond=AL, opcode=1111, comment=0x060000)
    mem.bus.write32(code, 0xef060000);
    cpu.step();
    expect(cpu.regs.cpsr & 0x1f).toBe(MODE_SYS); // mode unchanged
    expect(cpu.regs.r[0]).toBe(14);
    expect(cpu.regs.r[1]).toBe(2);
  });

  it("ARM SWI with unknown function number is silently NOP'd (no SVC fall-through)", () => {
    // Falling through to the real SVC entry sets PC=0x08, and with no
    // BIOS the CPU would NOP-slide up to the IRQ vector at 0x18 and
    // fire a spurious hleBiosIrqEntry — corrupting the IRQ stack
    // (Dead to Rights regression). Treat unimplemented SWIs as NOPs.
    const { cpu, mem } = makeFixture();
    const code = 0x02000000;
    cpu.regs.r[15] = code;
    const beforeMode = cpu.regs.cpsr & 0x1f;
    mem.bus.write32(code, 0xefff0000); // swi #0xFF0000 — not in dispatcher
    cpu.step();
    expect(cpu.regs.cpsr & 0x1f).toBe(beforeMode);
    expect(cpu.regs.r[15]).toBe(code + 4);
  });
});
