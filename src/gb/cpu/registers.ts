/**
 * Sharp LR35902 register file.
 *
 * 8-bit: A, B, C, D, E, H, L
 * Flags: F  (upper nibble only: Z N H C)
 * 16-bit pairs: AF, BC, DE, HL, SP, PC
 */

import type { StateReader, StateWriter } from "../serialization/serialization.js";

export const FLAG_Z = 0x80; // Zero
export const FLAG_N = 0x40; // Subtract
export const FLAG_H = 0x20; // Half-carry
export const FLAG_C = 0x10; // Carry

export class Registers {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  h: number;
  l: number;
  f: number;
  sp = 0xfffe;
  pc = 0x0100;

  /**
   * Seeds the post-boot register file. Games detect the host console by
   * inspecting `A`: 0x01 = DMG, 0x11 = CGB. The other registers match the
   * post-boot state documented in Pandocs for each model. When `preBoot`
   * is set, leave everything zeroed so the boot ROM itself produces the
   * post-boot state — the test harness uses this for `boot_*` ROMs.
   */
  constructor(cgb = false, preBoot = false) {
    if (preBoot) {
      this.a = 0;
      this.f = 0;
      this.b = 0;
      this.c = 0;
      this.d = 0;
      this.e = 0;
      this.h = 0;
      this.l = 0;
      this.sp = 0;
      this.pc = 0;
      return;
    }
    if (cgb) {
      this.a = 0x11;
      this.f = 0x80;
      this.b = 0x00;
      this.c = 0x00;
      this.d = 0xff;
      this.e = 0x56;
      this.h = 0x00;
      this.l = 0x0d;
    } else {
      this.a = 0x01;
      this.f = 0xb0;
      this.b = 0x00;
      this.c = 0x13;
      this.d = 0x00;
      this.e = 0xd8;
      this.h = 0x01;
      this.l = 0x4d;
    }
  }

  // ─── 16-bit pair accessors ────────────────────────────────────────────────

  get af(): number {
    return (this.a << 8) | (this.f & 0xf0);
  }
  set af(v: number) {
    this.a = (v >> 8) & 0xff;
    this.f = v & 0xf0;
  }

  get bc(): number {
    return (this.b << 8) | this.c;
  }
  set bc(v: number) {
    this.b = (v >> 8) & 0xff;
    this.c = v & 0xff;
  }

  get de(): number {
    return (this.d << 8) | this.e;
  }
  set de(v: number) {
    this.d = (v >> 8) & 0xff;
    this.e = v & 0xff;
  }

  get hl(): number {
    return (this.h << 8) | this.l;
  }
  set hl(v: number) {
    this.h = (v >> 8) & 0xff;
    this.l = v & 0xff;
  }

  // ─── Flag helpers ─────────────────────────────────────────────────────────

  getFlag(flag: number): boolean {
    return (this.f & flag) !== 0;
  }
  setFlag(flag: number, on: boolean): void {
    this.f = on ? (this.f | flag) & 0xf0 : this.f & ~flag & 0xf0;
  }

  get zf(): boolean {
    return this.getFlag(FLAG_Z);
  }
  set zf(v: boolean) {
    this.setFlag(FLAG_Z, v);
  }

  get nf(): boolean {
    return this.getFlag(FLAG_N);
  }
  set nf(v: boolean) {
    this.setFlag(FLAG_N, v);
  }

  get hf(): boolean {
    return this.getFlag(FLAG_H);
  }
  set hf(v: boolean) {
    this.setFlag(FLAG_H, v);
  }

  get cf(): boolean {
    return this.getFlag(FLAG_C);
  }
  set cf(v: boolean) {
    this.setFlag(FLAG_C, v);
  }

  // ─── Save state ───────────────────────────────────────────────────────────

  serialize(w: StateWriter): void {
    w.u8(this.a);
    w.u8(this.b);
    w.u8(this.c);
    w.u8(this.d);
    w.u8(this.e);
    w.u8(this.f);
    w.u8(this.h);
    w.u8(this.l);
    w.u16(this.sp);
    w.u16(this.pc);
  }
  deserialize(r: StateReader): void {
    this.a = r.u8();
    this.b = r.u8();
    this.c = r.u8();
    this.d = r.u8();
    this.e = r.u8();
    this.f = r.u8();
    this.h = r.u8();
    this.l = r.u8();
    this.sp = r.u16();
    this.pc = r.u16();
  }
}
