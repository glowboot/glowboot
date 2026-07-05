import { describe, expect, it } from "vitest";

import { Cx4 } from "./cx4.js";

function makeCx4(): Cx4 {
  const rom = new Uint8Array(0x200000);
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 3 + (i >> 11)) & 0xff;
  return new Cx4(rom);
}

/** Write a 16-bit LE value through the $6000-$7FFF port at $7Fxx. */
function w16(cx4: Cx4, addr: number, v: number): void {
  cx4.setC4(v & 0xff, addr);
  cx4.setC4((v >> 8) & 0xff, addr + 1);
}
function w24(cx4: Cx4, addr: number, v: number): void {
  cx4.setC4(v & 0xff, addr);
  cx4.setC4((v >> 8) & 0xff, addr + 1);
  cx4.setC4((v >> 16) & 0xff, addr + 2);
}
function r16(cx4: Cx4, addr: number): number {
  return cx4.getC4(addr) | (cx4.getC4(addr + 1) << 8);
}
function r24(cx4: Cx4, addr: number): number {
  return cx4.getC4(addr) | (cx4.getC4(addr + 1) << 8) | (cx4.getC4(addr + 2) << 16);
}
const trigger = (cx4: Cx4, cmd: number): void => cx4.setC4(cmd, 0x7f4f);

describe("Cx4 coprocessor", () => {
  it("reads back RAM and the always-ready $7F5E flag", () => {
    const cx4 = makeCx4();
    cx4.setC4(0xab, 0x6100);
    expect(cx4.getC4(0x6100)).toBe(0xab);
    expect(cx4.getC4(0x7f5e)).toBe(0); // ready flag
  });

  it("computes the Pythagorean hypotenuse (command $15)", () => {
    const cx4 = makeCx4();
    w16(cx4, 0x7f80, 3);
    w16(cx4, 0x7f83, 4);
    trigger(cx4, 0x15);
    expect(r16(cx4, 0x7f80)).toBe(5);
    // 5,12 → 13
    w16(cx4, 0x7f80, 5);
    w16(cx4, 0x7f83, 12);
    trigger(cx4, 0x15);
    expect(r16(cx4, 0x7f80)).toBe(13);
  });

  it("multiplies 24-bit values (command $25)", () => {
    const cx4 = makeCx4();
    w24(cx4, 0x7f80, 0x000100);
    w24(cx4, 0x7f83, 0x000003);
    trigger(cx4, 0x25);
    expect(r24(cx4, 0x7f80)).toBe(0x000300);
  });

  it("squares a signed 24-bit value (command $54)", () => {
    const cx4 = makeCx4();
    w24(cx4, 0x7f80, 0x000010); // 16² = 256
    trigger(cx4, 0x54);
    expect(r24(cx4, 0x7f83)).toBe(256);
  });

  it("sums the first 2 KiB of RAM (command $40)", () => {
    const cx4 = makeCx4();
    cx4.setC4(0x10, 0x6000);
    cx4.setC4(0x20, 0x6001);
    cx4.setC4(0x05, 0x67ff);
    trigger(cx4, 0x40);
    expect(r16(cx4, 0x7f80)).toBe(0x10 + 0x20 + 0x05);
  });

  it("computes atan into a 0-511 angle (command $1F)", () => {
    const cx4 = makeCx4();
    // (x=100, y=0) → angle 0
    w16(cx4, 0x7f80, 100);
    w16(cx4, 0x7f83, 0);
    trigger(cx4, 0x1f);
    expect(r16(cx4, 0x7f86)).toBe(0);
    // (x=0, y=100) → 0x80 (quarter turn)
    w16(cx4, 0x7f80, 0);
    w16(cx4, 0x7f83, 100);
    trigger(cx4, 0x1f);
    expect(r16(cx4, 0x7f86)).toBe(0x80);
  });

  it("reports its version id (command $89)", () => {
    const cx4 = makeCx4();
    trigger(cx4, 0x89);
    expect(cx4.getC4(0x7f80)).toBe(0x36);
    expect(cx4.getC4(0x7f81)).toBe(0x43);
    expect(cx4.getC4(0x7f82)).toBe(0x05);
  });

  it("loads the immediate test pattern (command $5C)", () => {
    const cx4 = makeCx4();
    trigger(cx4, 0x5c);
    // first four bytes of the known test pattern
    expect([cx4.getC4(0x6000), cx4.getC4(0x6001), cx4.getC4(0x6002), cx4.getC4(0x6003)]).toEqual([
      0x00, 0x00, 0x00, 0xff
    ]);
  });

  it("loads ROM into RAM on a $7F47 write", () => {
    const cx4 = makeCx4();
    // source $C10000, dest $6100, 8 bytes
    w24(cx4, 0x7f40, 0xc10000);
    w16(cx4, 0x7f43, 8); // size
    w16(cx4, 0x7f45, 0x6100); // dest
    cx4.setC4(0x00, 0x7f47); // trigger load
    // LoROM fold of $C10000 → ((0xc10000 & 0xff0000) >> 1) + 0 = 0x608000
    const base = ((0xc10000 & 0xff0000) >> 1) + (0xc10000 & 0x7fff);
    for (let i = 0; i < 8; i++) expect(cx4.getC4(0x6100 + i)).toBe(((base + i) * 3 + ((base + i) >> 11)) & 0xff);
  });
});
