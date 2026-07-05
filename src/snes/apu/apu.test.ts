import { describe, expect, it } from "vitest";

import { SnesApu } from "./apu.js";

/** Tick until port 0 reads `want` (the loader runs in emulated time, so
 *  every ack takes polls) — bounded like a real driver's timeout would be. */
function awaitPort0(smp: SnesApu, want: number): void {
  for (let i = 0; i < 4000 && smp.cpuReadPort(0) !== want; i++) smp.tick(21 * 4);
  expect(smp.cpuReadPort(0)).toBe(want);
}

/** Drive the documented IPL upload protocol from the main-CPU side. */
function uploadAndRun(smp: SnesApu, addr: number, data: number[], entry: number): void {
  awaitPort0(smp, 0xaa); // boot ROM announce
  // kick: port1 != 0, port2/3 = address, port0 = $CC
  smp.cpuWritePort(1, 0x01);
  smp.cpuWritePort(2, addr & 0xff);
  smp.cpuWritePort(3, addr >> 8);
  smp.cpuWritePort(0, 0xcc);
  awaitPort0(smp, 0xcc);
  // per-byte counter loop
  data.forEach((byte, i) => {
    smp.cpuWritePort(1, byte);
    smp.cpuWritePort(0, i & 0xff);
    awaitPort0(smp, i & 0xff);
  });
  // execute record: counter skips ahead, port1 = 0, port2/3 = entry
  smp.cpuWritePort(1, 0x00);
  smp.cpuWritePort(2, entry & 0xff);
  smp.cpuWritePort(3, entry >> 8);
  smp.cpuWritePort(0, (data.length + 2) & 0xff);
  awaitPort0(smp, (data.length + 2) & 0xff);
  smp.tick(21 * 64); // hand-off gap before the driver's first instruction
}

describe("SnesApu", () => {
  it("announces the IPL boot ROM after its init delay", () => {
    const smp = new SnesApu();
    expect(smp.cpuReadPort(0)).toBe(0); // still clearing zero page
    awaitPort0(smp, 0xaa);
    expect(smp.cpuReadPort(1)).toBe(0xbb);
    expect(smp.cpu.stopped).toBe(true);
  });

  it("uploads a block over the IPL protocol and executes it", () => {
    const smp = new SnesApu();
    // driver: MOV A,#$5A; MOV $F4,A (port0); BRA -2 (spin)
    uploadAndRun(smp, 0x0200, [0xe8, 0x5a, 0xc4, 0xf4, 0x2f, 0xfe], 0x0200);
    expect(smp.aram[0x0200]).toBe(0xe8);
    expect(smp.cpu.stopped).toBe(false);
    expect(smp.cpu.pc).toBe(0x0200);
    smp.tick(21 * 160); // hand-off delay + driver execution
    expect(smp.cpuReadPort(0)).toBe(0x5a); // driver drove the port
  });

  it("supports multi-block uploads before execution", () => {
    const smp = new SnesApu();
    awaitPort0(smp, 0xaa);
    smp.cpuWritePort(1, 0x01);
    smp.cpuWritePort(2, 0x00);
    smp.cpuWritePort(3, 0x03);
    smp.cpuWritePort(0, 0xcc);
    awaitPort0(smp, 0xcc);
    smp.cpuWritePort(1, 0x11);
    smp.cpuWritePort(0, 0);
    awaitPort0(smp, 0);
    // next block at $0400: counter skips, port1 != 0; the new block's
    // data counter restarts at 0
    smp.cpuWritePort(1, 0x01);
    smp.cpuWritePort(2, 0x00);
    smp.cpuWritePort(3, 0x04);
    smp.cpuWritePort(0, 3);
    awaitPort0(smp, 3);
    smp.cpuWritePort(1, 0x22);
    smp.cpuWritePort(0, 0);
    awaitPort0(smp, 0);
    expect(smp.aram[0x0300]).toBe(0x11);
    expect(smp.aram[0x0400]).toBe(0x22);
  });

  it("runs the SPC700 against ARAM and the IO page", () => {
    const smp = new SnesApu();
    // MOV A,#$07; MOV $FA,A (timer0 target); MOV A,#$01; MOV $F1,A (enable);
    // loop: MOV A,$FD; BEQ loop ($FD is read-to-clear, so latch the first
    // nonzero value); MOV $F5,A; done: BRA done
    uploadAndRun(
      smp,
      0x0200,
      [0xe8, 0x07, 0xc4, 0xfa, 0xe8, 0x01, 0xc4, 0xf1, 0xe4, 0xfd, 0xf0, 0xfc, 0xc4, 0xf5, 0x2f, 0xfe],
      0x0200
    );
    // timer0 divides by 128, target 7 → one counter tick per 896 SPC cycles
    smp.tick(21 * 2100);
    expect(smp.cpuReadPort(1)).toBeGreaterThanOrEqual(1);
  });

  it("clears the SPC-side ports via CONTROL bits 4/5", () => {
    const smp = new SnesApu();
    uploadAndRun(smp, 0x0200, [0xe8, 0x30, 0xc4, 0xf1, 0x2f, 0xfe], 0x0200); // MOV A,#$30; MOV $F1,A
    smp.cpuWritePort(0, 0x99);
    smp.cpuWritePort(2, 0x99);
    smp.tick(21 * 128);
    expect(smp.portsToSpc[0]).toBe(0);
    expect(smp.portsToSpc[2]).toBe(0);
  });

  it("exposes the DSP register pair at $F2/$F3", () => {
    const smp = new SnesApu();
    // MOV A,#$4C; MOV $F2,A; MOV A,#$FF; MOV $F3,A (KON = $FF); spin
    uploadAndRun(smp, 0x0200, [0xe8, 0x4c, 0xc4, 0xf2, 0xe8, 0xff, 0xc4, 0xf3, 0x2f, 0xfe], 0x0200);
    smp.tick(21 * 160);
    expect(smp.dsp.reg(0x4c)).toBe(0xff);
  });
});
