/**
 * Sony SPC700 CPU core — the S-SMP's processor.
 *
 * An 8-bit 6502 cousin with its own ISA: a direct page selected by the P
 * flag (page 0 or 1), a half-carry flag feeding DAA/DAS, 16-bit word
 * operations on the YA pair (ADDW/SUBW/CMPW/MOVW, MUL, the famously odd
 * DIV), single-bit memory ops on 13-bit address + 3-bit bit-index
 * operands, and table calls (TCALL/PCALL). All 256 opcodes are defined.
 *
 * Every memory access goes through the bus and costs one cycle; internal
 * operations count via `idle()`. Developed against the SingleStepTests
 * spc700 vectors (1000 cases per opcode, final state + cycle counts) —
 * the corner behaviours they pinned live on in cpu.test.ts.
 *
 * Reference: fullsnes "SNES APU" (SPC700 chapter).
 */

const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_H = 0x08;
const FLAG_B = 0x10;
const FLAG_P = 0x20;
const FLAG_V = 0x40;
const FLAG_N = 0x80;

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

export interface Spc700Bus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

export class Spc700 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xff;
  pc = 0;
  psw = 0;

  cycles = 0;
  stopped = false;
  sleeping = false;

  constructor(private readonly bus: Spc700Bus) {}

  serialize(w: SnesStateWriter): void {
    w.u8(this.a);
    w.u8(this.x);
    w.u8(this.y);
    w.u8(this.sp);
    w.u16(this.pc);
    w.u8(this.psw);
    w.f64(this.cycles);
    w.bool(this.stopped);
    w.bool(this.sleeping);
  }

  deserialize(r: SnesStateReader): void {
    this.a = r.u8();
    this.x = r.u8();
    this.y = r.u8();
    this.sp = r.u8();
    this.pc = r.u16();
    this.psw = r.u8();
    this.cycles = r.f64();
    this.stopped = r.bool();
    this.sleeping = r.bool();
  }

  // ── bus primitives ────────────────────────────────────────────────────

  private read(addr: number): number {
    this.cycles++;
    return this.bus.read(addr & 0xffff) & 0xff;
  }

  private write(addr: number, value: number): void {
    this.cycles++;
    this.bus.write(addr & 0xffff, value & 0xff);
  }

  private idle(): void {
    this.cycles++;
  }

  private fetch(): number {
    const v = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    return this.fetch() | (this.fetch() << 8);
  }

  // ── addressing ────────────────────────────────────────────────────────

  private get dpBase(): number {
    return (this.psw & FLAG_P) !== 0 ? 0x100 : 0x000;
  }

  private dp(off: number): number {
    return this.dpBase | (off & 0xff);
  }

  private amDp(): number {
    return this.dp(this.fetch());
  }

  private amDpX(): number {
    this.idle();
    return this.dp(this.fetch() + this.x);
  }

  private amDpY(): number {
    this.idle();
    return this.dp(this.fetch() + this.y);
  }

  private amAbs(): number {
    return this.fetch16();
  }

  private amAbsX(): number {
    this.idle();
    return (this.fetch16() + this.x) & 0xffff;
  }

  private amAbsY(): number {
    this.idle();
    return (this.fetch16() + this.y) & 0xffff;
  }

  private amIndX(): number {
    this.idle();
    return this.dp(this.x);
  }

  /** [dp+X] — pointer in the direct page, page-wrapping. */
  private amIndDpX(): number {
    const base = this.fetch() + this.x;
    this.idle();
    return this.read(this.dp(base)) | (this.read(this.dp(base + 1)) << 8);
  }

  /** [dp]+Y */
  private amIndDpY(): number {
    const base = this.fetch();
    const ptr = this.read(this.dp(base)) | (this.read(this.dp(base + 1)) << 8);
    this.idle();
    return (ptr + this.y) & 0xffff;
  }

  // ── flags ─────────────────────────────────────────────────────────────

  private setNZ(v: number): number {
    this.psw = (this.psw & ~(FLAG_N | FLAG_Z)) | (v & 0x80) | ((v & 0xff) === 0 ? FLAG_Z : 0);
    return v & 0xff;
  }

  private setNZ16(v: number): number {
    this.psw = (this.psw & ~(FLAG_N | FLAG_Z)) | ((v >> 8) & 0x80) | ((v & 0xffff) === 0 ? FLAG_Z : 0);
    return v & 0xffff;
  }

  private setFlag(mask: number, on: boolean): void {
    this.psw = on ? this.psw | mask : this.psw & ~mask;
  }

  // ── ALU ───────────────────────────────────────────────────────────────

  private adc(a: number, b: number): number {
    const c = this.psw & FLAG_C;
    const r = a + b + c;
    this.setFlag(FLAG_C, r > 0xff);
    this.setFlag(FLAG_H, (a & 0xf) + (b & 0xf) + c > 0xf);
    this.setFlag(FLAG_V, (~(a ^ b) & (a ^ r) & 0x80) !== 0);
    return this.setNZ(r);
  }

  private sbc(a: number, b: number): number {
    return this.adc(a, b ^ 0xff);
  }

  private cmp(a: number, b: number): void {
    const r = a - b;
    this.setFlag(FLAG_C, r >= 0);
    this.setNZ(r & 0xff);
  }

  private asl(v: number): number {
    this.setFlag(FLAG_C, (v & 0x80) !== 0);
    return this.setNZ((v << 1) & 0xff);
  }

  private lsr(v: number): number {
    this.setFlag(FLAG_C, (v & 1) !== 0);
    return this.setNZ(v >> 1);
  }

  private rol(v: number): number {
    const c = this.psw & FLAG_C;
    this.setFlag(FLAG_C, (v & 0x80) !== 0);
    return this.setNZ(((v << 1) | c) & 0xff);
  }

  private ror(v: number): number {
    const c = (this.psw & FLAG_C) !== 0 ? 0x80 : 0;
    this.setFlag(FLAG_C, (v & 1) !== 0);
    return this.setNZ((v >> 1) | c);
  }

  // ── memory op helpers ─────────────────────────────────────────────────

  private rmw(addr: number, fn: (v: number) => number): void {
    this.write(addr, fn(this.read(addr)));
  }

  /** dp,dp / dp,#imm / (X),(Y) two-operand ALU forms: op(dest) = dest ⊕ src. */
  private aluDpDp(fn: (a: number, b: number) => number): void {
    const src = this.read(this.amDp());
    const dst = this.amDp();
    this.write(dst, fn(this.read(dst), src));
  }

  private aluDpImm(fn: (a: number, b: number) => number): void {
    const src = this.fetch();
    const dst = this.amDp();
    this.write(dst, fn(this.read(dst), src));
  }

  private aluXY(fn: (a: number, b: number) => number): void {
    this.idle();
    const src = this.read(this.dp(this.y));
    const dst = this.dp(this.x);
    this.write(dst, fn(this.read(dst), src));
  }

  /** CMP variants of the two-operand forms write nothing back. */
  private cmpDpDp(): void {
    const src = this.read(this.amDp());
    const dst = this.read(this.amDp());
    this.cmp(dst, src);
    this.idle();
  }

  private cmpDpImm(): void {
    const src = this.fetch();
    const dst = this.read(this.amDp());
    this.cmp(dst, src);
    this.idle();
  }

  private cmpXY(): void {
    this.idle();
    const src = this.read(this.dp(this.y));
    const dst = this.read(this.dp(this.x));
    this.cmp(dst, src);
    this.idle();
  }

  // ── stack ─────────────────────────────────────────────────────────────

  private push(v: number): void {
    this.write(0x100 | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pop(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(0x100 | this.sp);
  }

  // ── control flow ──────────────────────────────────────────────────────

  private branch(taken: boolean): void {
    const off = this.fetch();
    if (!taken) return;
    this.idle();
    this.idle();
    this.pc = (this.pc + ((off << 24) >> 24)) & 0xffff;
  }

  /** 13-bit address + 3-bit bit-index operand for the bit ops. */
  private bitOperand(): { addr: number; bit: number } {
    const w = this.fetch16();
    return { addr: w & 0x1fff, bit: w >> 13 };
  }

  // ── execution ─────────────────────────────────────────────────────────

  step(): void {
    if (this.stopped || this.sleeping) {
      this.idle();
      return;
    }
    this.execute(this.fetch());
  }

  // prettier-ignore
  private execute(op: number): void {
    switch (op) {
      case 0x00: this.idle(); break; // NOP
      // ── OR ──
      case 0x04: this.a = this.setNZ(this.a | this.read(this.amDp())); break;
      case 0x05: this.a = this.setNZ(this.a | this.read(this.amAbs())); break;
      case 0x06: this.a = this.setNZ(this.a | this.read(this.amIndX())); break;
      case 0x07: this.a = this.setNZ(this.a | this.read(this.amIndDpX())); break;
      case 0x08: this.a = this.setNZ(this.a | this.fetch()); break;
      case 0x09: this.aluDpDp((d, s) => this.setNZ(d | s)); break;
      case 0x14: this.a = this.setNZ(this.a | this.read(this.amDpX())); break;
      case 0x15: this.a = this.setNZ(this.a | this.read(this.amAbsX())); break;
      case 0x16: this.a = this.setNZ(this.a | this.read(this.amAbsY())); break;
      case 0x17: this.a = this.setNZ(this.a | this.read(this.amIndDpY())); break;
      case 0x18: this.aluDpImm((d, s) => this.setNZ(d | s)); break;
      case 0x19: this.aluXY((d, s) => this.setNZ(d | s)); break;
      // ── AND ──
      case 0x24: this.a = this.setNZ(this.a & this.read(this.amDp())); break;
      case 0x25: this.a = this.setNZ(this.a & this.read(this.amAbs())); break;
      case 0x26: this.a = this.setNZ(this.a & this.read(this.amIndX())); break;
      case 0x27: this.a = this.setNZ(this.a & this.read(this.amIndDpX())); break;
      case 0x28: this.a = this.setNZ(this.a & this.fetch()); break;
      case 0x29: this.aluDpDp((d, s) => this.setNZ(d & s)); break;
      case 0x34: this.a = this.setNZ(this.a & this.read(this.amDpX())); break;
      case 0x35: this.a = this.setNZ(this.a & this.read(this.amAbsX())); break;
      case 0x36: this.a = this.setNZ(this.a & this.read(this.amAbsY())); break;
      case 0x37: this.a = this.setNZ(this.a & this.read(this.amIndDpY())); break;
      case 0x38: this.aluDpImm((d, s) => this.setNZ(d & s)); break;
      case 0x39: this.aluXY((d, s) => this.setNZ(d & s)); break;
      // ── EOR ──
      case 0x44: this.a = this.setNZ(this.a ^ this.read(this.amDp())); break;
      case 0x45: this.a = this.setNZ(this.a ^ this.read(this.amAbs())); break;
      case 0x46: this.a = this.setNZ(this.a ^ this.read(this.amIndX())); break;
      case 0x47: this.a = this.setNZ(this.a ^ this.read(this.amIndDpX())); break;
      case 0x48: this.a = this.setNZ(this.a ^ this.fetch()); break;
      case 0x49: this.aluDpDp((d, s) => this.setNZ(d ^ s)); break;
      case 0x54: this.a = this.setNZ(this.a ^ this.read(this.amDpX())); break;
      case 0x55: this.a = this.setNZ(this.a ^ this.read(this.amAbsX())); break;
      case 0x56: this.a = this.setNZ(this.a ^ this.read(this.amAbsY())); break;
      case 0x57: this.a = this.setNZ(this.a ^ this.read(this.amIndDpY())); break;
      case 0x58: this.aluDpImm((d, s) => this.setNZ(d ^ s)); break;
      case 0x59: this.aluXY((d, s) => this.setNZ(d ^ s)); break;
      // ── CMP ──
      case 0x64: this.cmp(this.a, this.read(this.amDp())); break;
      case 0x65: this.cmp(this.a, this.read(this.amAbs())); break;
      case 0x66: this.cmp(this.a, this.read(this.amIndX())); break;
      case 0x67: this.cmp(this.a, this.read(this.amIndDpX())); break;
      case 0x68: this.cmp(this.a, this.fetch()); break;
      case 0x69: this.cmpDpDp(); break;
      case 0x74: this.cmp(this.a, this.read(this.amDpX())); break;
      case 0x75: this.cmp(this.a, this.read(this.amAbsX())); break;
      case 0x76: this.cmp(this.a, this.read(this.amAbsY())); break;
      case 0x77: this.cmp(this.a, this.read(this.amIndDpY())); break;
      case 0x78: this.cmpDpImm(); break;
      case 0x79: this.cmpXY(); break;
      case 0x1e: this.cmp(this.x, this.read(this.amAbs())); break;
      case 0x3e: this.cmp(this.x, this.read(this.amDp())); break;
      case 0xc8: this.cmp(this.x, this.fetch()); break;
      case 0x5e: this.cmp(this.y, this.read(this.amAbs())); break;
      case 0x7e: this.cmp(this.y, this.read(this.amDp())); break;
      case 0xad: this.cmp(this.y, this.fetch()); break;
      // ── ADC ──
      case 0x84: this.a = this.adc(this.a, this.read(this.amDp())); break;
      case 0x85: this.a = this.adc(this.a, this.read(this.amAbs())); break;
      case 0x86: this.a = this.adc(this.a, this.read(this.amIndX())); break;
      case 0x87: this.a = this.adc(this.a, this.read(this.amIndDpX())); break;
      case 0x88: this.a = this.adc(this.a, this.fetch()); break;
      case 0x89: this.aluDpDp((d, s) => this.adc(d, s)); break;
      case 0x94: this.a = this.adc(this.a, this.read(this.amDpX())); break;
      case 0x95: this.a = this.adc(this.a, this.read(this.amAbsX())); break;
      case 0x96: this.a = this.adc(this.a, this.read(this.amAbsY())); break;
      case 0x97: this.a = this.adc(this.a, this.read(this.amIndDpY())); break;
      case 0x98: this.aluDpImm((d, s) => this.adc(d, s)); break;
      case 0x99: this.aluXY((d, s) => this.adc(d, s)); break;
      // ── SBC ──
      case 0xa4: this.a = this.sbc(this.a, this.read(this.amDp())); break;
      case 0xa5: this.a = this.sbc(this.a, this.read(this.amAbs())); break;
      case 0xa6: this.a = this.sbc(this.a, this.read(this.amIndX())); break;
      case 0xa7: this.a = this.sbc(this.a, this.read(this.amIndDpX())); break;
      case 0xa8: this.a = this.sbc(this.a, this.fetch()); break;
      case 0xa9: this.aluDpDp((d, s) => this.sbc(d, s)); break;
      case 0xb4: this.a = this.sbc(this.a, this.read(this.amDpX())); break;
      case 0xb5: this.a = this.sbc(this.a, this.read(this.amAbsX())); break;
      case 0xb6: this.a = this.sbc(this.a, this.read(this.amAbsY())); break;
      case 0xb7: this.a = this.sbc(this.a, this.read(this.amIndDpY())); break;
      case 0xb8: this.aluDpImm((d, s) => this.sbc(d, s)); break;
      case 0xb9: this.aluXY((d, s) => this.sbc(d, s)); break;
      // ── MOV stores ──
      case 0xc4: this.idle(); this.write(this.amDp(), this.a); break;
      case 0xc5: this.idle(); this.write(this.amAbs(), this.a); break;
      case 0xc6: this.idle(); this.write(this.amIndX(), this.a); break;
      case 0xc7: this.idle(); this.write(this.amIndDpX(), this.a); break;
      case 0xc9: this.idle(); this.write(this.amAbs(), this.x); break;
      case 0xcb: this.idle(); this.write(this.amDp(), this.y); break;
      case 0xcc: this.idle(); this.write(this.amAbs(), this.y); break;
      case 0xd4: this.idle(); this.write(this.amDpX(), this.a); break;
      case 0xd5: this.idle(); this.write(this.amAbsX(), this.a); break;
      case 0xd6: this.idle(); this.write(this.amAbsY(), this.a); break;
      case 0xd7: this.idle(); this.write(this.amIndDpY(), this.a); break;
      case 0xd8: this.idle(); this.write(this.amDp(), this.x); break;
      case 0xd9: this.idle(); this.write(this.amDpY(), this.x); break;
      case 0xdb: this.idle(); this.write(this.amDpX(), this.y); break;
      case 0x8f: { const v = this.fetch(); const dst = this.amDp(); this.read(dst); this.write(dst, v); break; } // MOV dp,#imm
      case 0xfa: { const src = this.read(this.amDp()); this.write(this.amDp(), src); break; } // MOV dp,dp
      case 0xaf: this.idle(); this.idle(); this.write(this.dp(this.x), this.a); this.x = (this.x + 1) & 0xff; break; // MOV (X)+,A
      // ── MOV loads ──
      case 0xe4: this.a = this.setNZ(this.read(this.amDp())); break;
      case 0xe5: this.a = this.setNZ(this.read(this.amAbs())); break;
      case 0xe6: this.a = this.setNZ(this.read(this.amIndX())); break;
      case 0xe7: this.a = this.setNZ(this.read(this.amIndDpX())); break;
      case 0xe8: this.a = this.setNZ(this.fetch()); break;
      case 0xe9: this.x = this.setNZ(this.read(this.amAbs())); break;
      case 0xeb: this.y = this.setNZ(this.read(this.amDp())); break;
      case 0xec: this.y = this.setNZ(this.read(this.amAbs())); break;
      case 0xf4: this.a = this.setNZ(this.read(this.amDpX())); break;
      case 0xf5: this.a = this.setNZ(this.read(this.amAbsX())); break;
      case 0xf6: this.a = this.setNZ(this.read(this.amAbsY())); break;
      case 0xf7: this.a = this.setNZ(this.read(this.amIndDpY())); break;
      case 0xf8: this.x = this.setNZ(this.read(this.amDp())); break;
      case 0xf9: this.x = this.setNZ(this.read(this.amDpY())); break;
      case 0xfb: this.y = this.setNZ(this.read(this.amDpX())); break;
      case 0xcd: this.x = this.setNZ(this.fetch()); break;
      case 0x8d: this.y = this.setNZ(this.fetch()); break;
      case 0xbf: { this.idle(); const v = this.read(this.dp(this.x)); this.idle(); this.x = (this.x + 1) & 0xff; this.a = this.setNZ(v); break; } // MOV A,(X)+
      // ── register transfers ──
      case 0x5d: this.idle(); this.x = this.setNZ(this.a); break;
      case 0x7d: this.idle(); this.a = this.setNZ(this.x); break;
      case 0x9d: this.idle(); this.x = this.setNZ(this.sp); break;
      case 0xbd: this.idle(); this.sp = this.x; break;
      case 0xdd: this.idle(); this.a = this.setNZ(this.y); break;
      case 0xfd: this.idle(); this.y = this.setNZ(this.a); break;
      // ── RMW dp/abs/A ──
      case 0x0b: this.rmw(this.amDp(), (v) => this.asl(v)); break;
      case 0x0c: this.rmw(this.amAbs(), (v) => this.asl(v)); break;
      case 0x1b: this.rmw(this.amDpX(), (v) => this.asl(v)); break;
      case 0x1c: this.idle(); this.a = this.asl(this.a); break;
      case 0x2b: this.rmw(this.amDp(), (v) => this.rol(v)); break;
      case 0x2c: this.rmw(this.amAbs(), (v) => this.rol(v)); break;
      case 0x3b: this.rmw(this.amDpX(), (v) => this.rol(v)); break;
      case 0x3c: this.idle(); this.a = this.rol(this.a); break;
      case 0x4b: this.rmw(this.amDp(), (v) => this.lsr(v)); break;
      case 0x4c: this.rmw(this.amAbs(), (v) => this.lsr(v)); break;
      case 0x5b: this.rmw(this.amDpX(), (v) => this.lsr(v)); break;
      case 0x5c: this.idle(); this.a = this.lsr(this.a); break;
      case 0x6b: this.rmw(this.amDp(), (v) => this.ror(v)); break;
      case 0x6c: this.rmw(this.amAbs(), (v) => this.ror(v)); break;
      case 0x7b: this.rmw(this.amDpX(), (v) => this.ror(v)); break;
      case 0x7c: this.idle(); this.a = this.ror(this.a); break;
      case 0x8b: this.rmw(this.amDp(), (v) => this.setNZ(v - 1)); break;
      case 0x8c: this.rmw(this.amAbs(), (v) => this.setNZ(v - 1)); break;
      case 0x9b: this.rmw(this.amDpX(), (v) => this.setNZ(v - 1)); break;
      case 0x9c: this.idle(); this.a = this.setNZ(this.a - 1); break;
      case 0xab: this.rmw(this.amDp(), (v) => this.setNZ(v + 1)); break;
      case 0xac: this.rmw(this.amAbs(), (v) => this.setNZ(v + 1)); break;
      case 0xbb: this.rmw(this.amDpX(), (v) => this.setNZ(v + 1)); break;
      case 0xbc: this.idle(); this.a = this.setNZ(this.a + 1); break;
      case 0x1d: this.idle(); this.x = this.setNZ(this.x - 1); break;
      case 0x3d: this.idle(); this.x = this.setNZ(this.x + 1); break;
      case 0xdc: this.idle(); this.y = this.setNZ(this.y - 1); break;
      case 0xfc: this.idle(); this.y = this.setNZ(this.y + 1); break;
      // ── 16-bit YA ops ──
      case 0x1a: { const addr = this.amDp(); const lo = this.read(addr); const r = (lo | (this.read(this.dp(addr + 1)) << 8)) - 1; this.write(addr, r & 0xff); this.write(this.dp(addr + 1), (r >> 8) & 0xff); this.setNZ16(r & 0xffff); break; } // DECW
      case 0x3a: { const addr = this.amDp(); const lo = this.read(addr); const r = (lo | (this.read(this.dp(addr + 1)) << 8)) + 1; this.write(addr, r & 0xff); this.write(this.dp(addr + 1), (r >> 8) & 0xff); this.setNZ16(r & 0xffff); break; } // INCW
      case 0x5a: { // CMPW YA,dp
        const addr = this.amDp();
        const w = this.read(addr) | (this.read(this.dp(addr + 1)) << 8);
        const ya = (this.y << 8) | this.a;
        const r = ya - w;
        this.setFlag(FLAG_C, r >= 0);
        this.setNZ16(r & 0xffff);
        break;
      }
      case 0x7a: { // ADDW YA,dp
        const addr = this.amDp();
        const w = this.read(addr) | (this.read(this.dp(addr + 1)) << 8);
        this.idle();
        const ya = (this.y << 8) | this.a;
        const r = ya + w;
        this.setFlag(FLAG_C, r > 0xffff);
        this.setFlag(FLAG_H, ((ya & 0xfff) + (w & 0xfff)) > 0xfff);
        this.setFlag(FLAG_V, (~(ya ^ w) & (ya ^ r) & 0x8000) !== 0);
        this.a = r & 0xff;
        this.y = (r >> 8) & 0xff;
        this.setNZ16(r & 0xffff);
        break;
      }
      case 0x9a: { // SUBW YA,dp
        const addr = this.amDp();
        const w = this.read(addr) | (this.read(this.dp(addr + 1)) << 8);
        this.idle();
        const ya = (this.y << 8) | this.a;
        const inv = w ^ 0xffff;
        const r = ya + inv + 1;
        this.setFlag(FLAG_C, r > 0xffff);
        this.setFlag(FLAG_H, ((ya & 0xfff) + (inv & 0xfff) + 1) > 0xfff);
        this.setFlag(FLAG_V, (~(ya ^ inv) & (ya ^ r) & 0x8000) !== 0);
        this.a = r & 0xff;
        this.y = (r >> 8) & 0xff;
        this.setNZ16(r & 0xffff);
        break;
      }
      case 0xba: { const addr = this.amDp(); this.a = this.read(addr); this.idle(); this.y = this.read(this.dp(addr + 1)); this.setNZ16((this.y << 8) | this.a); break; } // MOVW YA,dp
      case 0xda: { const addr = this.amDp(); this.read(addr); this.write(addr, this.a); this.write(this.dp(addr + 1), this.y); break; } // MOVW dp,YA
      case 0xcf: { // MUL YA
        for (let i = 0; i < 8; i++) this.idle();
        const r = this.y * this.a;
        this.a = r & 0xff;
        this.y = (r >> 8) & 0xff;
        this.setNZ(this.y);
        break;
      }
      case 0x9e: this.div(); break;
      // ── decimal adjust ──
      case 0xdf: { // DAA A
        this.idle(); this.idle();
        if ((this.psw & FLAG_C) !== 0 || this.a > 0x99) {
          this.setFlag(FLAG_C, true);
          this.a = (this.a + 0x60) & 0xff;
        }
        if ((this.psw & FLAG_H) !== 0 || (this.a & 0xf) > 9) {
          this.a = (this.a + 0x06) & 0xff;
        }
        this.setNZ(this.a);
        break;
      }
      case 0xbe: { // DAS A
        this.idle(); this.idle();
        if ((this.psw & FLAG_C) === 0 || this.a > 0x99) {
          this.setFlag(FLAG_C, false);
          this.a = (this.a - 0x60) & 0xff;
        }
        if ((this.psw & FLAG_H) === 0 || (this.a & 0xf) > 9) {
          this.a = (this.a - 0x06) & 0xff;
        }
        this.setNZ(this.a);
        break;
      }
      case 0x9f: this.idle(); this.idle(); this.idle(); this.idle(); this.a = this.setNZ(((this.a >> 4) | (this.a << 4)) & 0xff); break; // XCN
      // ── single-bit ops ──
      case 0x02: case 0x22: case 0x42: case 0x62: case 0x82: case 0xa2: case 0xc2: case 0xe2:
        this.rmw(this.amDp(), (v) => v | (1 << (op >> 5))); break; // SET1
      case 0x12: case 0x32: case 0x52: case 0x72: case 0x92: case 0xb2: case 0xd2: case 0xf2:
        this.rmw(this.amDp(), (v) => v & ~(1 << (op >> 5))); break; // CLR1
      case 0x03: case 0x23: case 0x43: case 0x63: case 0x83: case 0xa3: case 0xc3: case 0xe3: { // BBS
        const v = this.read(this.amDp());
        this.idle();
        this.branch((v & (1 << (op >> 5))) !== 0);
        break;
      }
      case 0x13: case 0x33: case 0x53: case 0x73: case 0x93: case 0xb3: case 0xd3: case 0xf3: { // BBC
        const v = this.read(this.amDp());
        this.idle();
        this.branch((v & (1 << (op >> 5))) === 0);
        break;
      }
      case 0x0a: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.idle(); this.setFlag(FLAG_C, ((this.psw & FLAG_C) !== 0) || (v & (1 << bit)) !== 0); break; } // OR1 C,m.b
      case 0x2a: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.idle(); this.setFlag(FLAG_C, ((this.psw & FLAG_C) !== 0) || (v & (1 << bit)) === 0); break; } // OR1 C,/m.b
      case 0x4a: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.setFlag(FLAG_C, ((this.psw & FLAG_C) !== 0) && (v & (1 << bit)) !== 0); break; } // AND1 C,m.b
      case 0x6a: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.setFlag(FLAG_C, ((this.psw & FLAG_C) !== 0) && (v & (1 << bit)) === 0); break; } // AND1 C,/m.b
      case 0x8a: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.idle(); this.setFlag(FLAG_C, ((this.psw & FLAG_C) !== 0) !== ((v & (1 << bit)) !== 0)); break; } // EOR1
      case 0xaa: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.setFlag(FLAG_C, (v & (1 << bit)) !== 0); break; } // MOV1 C,m.b
      case 0xca: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.idle(); const c = (this.psw & FLAG_C) !== 0; this.write(addr, c ? v | (1 << bit) : v & ~(1 << bit)); break; } // MOV1 m.b,C
      case 0xea: { const { addr, bit } = this.bitOperand(); const v = this.read(addr); this.write(addr, v ^ (1 << bit)); break; } // NOT1
      case 0x0e: { const addr = this.amAbs(); const v = this.read(addr); this.setNZ((this.a - v) & 0xff); this.read(addr); this.write(addr, v | this.a); break; } // TSET1
      case 0x4e: { const addr = this.amAbs(); const v = this.read(addr); this.setNZ((this.a - v) & 0xff); this.read(addr); this.write(addr, v & ~this.a); break; } // TCLR1
      // ── branches ──
      case 0x10: this.branch((this.psw & FLAG_N) === 0); break;
      case 0x30: this.branch((this.psw & FLAG_N) !== 0); break;
      case 0x50: this.branch((this.psw & FLAG_V) === 0); break;
      case 0x70: this.branch((this.psw & FLAG_V) !== 0); break;
      case 0x90: this.branch((this.psw & FLAG_C) === 0); break;
      case 0xb0: this.branch((this.psw & FLAG_C) !== 0); break;
      case 0xd0: this.branch((this.psw & FLAG_Z) === 0); break;
      case 0xf0: this.branch((this.psw & FLAG_Z) !== 0); break;
      case 0x2f: this.branch(true); break; // BRA
      case 0x2e: { const v = this.read(this.amDp()); this.idle(); this.branch(this.a !== v); break; } // CBNE dp
      case 0xde: { const v = this.read(this.amDpX()); this.idle(); this.branch(this.a !== v); break; } // CBNE dp+X
      case 0x6e: { const addr = this.amDp(); const v = (this.read(addr) - 1) & 0xff; this.write(addr, v); this.branch(v !== 0); break; } // DBNZ dp
      case 0xfe: { this.idle(); this.idle(); this.y = (this.y - 1) & 0xff; this.branch(this.y !== 0); break; } // DBNZ Y
      // ── jumps / calls ──
      case 0x5f: this.pc = this.fetch16(); break; // JMP !abs
      case 0x1f: { const base = this.amAbsX(); this.pc = this.read(base) | (this.read((base + 1) & 0xffff) << 8); break; } // JMP [!abs+X]
      case 0x3f: { const target = this.fetch16(); this.idle(); this.push(this.pc >> 8); this.push(this.pc & 0xff); this.idle(); this.idle(); this.pc = target; break; } // CALL
      case 0x4f: { const u = this.fetch(); this.idle(); this.push(this.pc >> 8); this.push(this.pc & 0xff); this.idle(); this.pc = 0xff00 | u; break; } // PCALL
      case 0x01: case 0x11: case 0x21: case 0x31: case 0x41: case 0x51: case 0x61: case 0x71:
      case 0x81: case 0x91: case 0xa1: case 0xb1: case 0xc1: case 0xd1: case 0xe1: case 0xf1: { // TCALL n
        this.idle();
        this.idle();
        this.push(this.pc >> 8);
        this.push(this.pc & 0xff);
        this.idle();
        const vec = 0xffde - ((op >> 4) << 1);
        this.pc = this.read(vec) | (this.read(vec + 1) << 8);
        break;
      }
      case 0x6f: { this.idle(); const lo = this.pop(); this.pc = lo | (this.pop() << 8); this.idle(); break; } // RET
      case 0x7f: { this.idle(); this.idle(); this.psw = this.pop(); const lo = this.pop(); this.pc = lo | (this.pop() << 8); break; } // RETI
      case 0x0f: { // BRK
        this.idle();
        this.push(this.pc >> 8);
        this.push(this.pc & 0xff);
        this.push(this.psw);
        this.idle();
        this.psw = (this.psw | FLAG_B) & ~FLAG_I;
        this.pc = this.read(0xffde) | (this.read(0xffdf) << 8);
        break;
      }
      // ── stack ──
      case 0x0d: this.idle(); this.push(this.psw); this.idle(); break;
      case 0x2d: this.idle(); this.push(this.a); this.idle(); break;
      case 0x4d: this.idle(); this.push(this.x); this.idle(); break;
      case 0x6d: this.idle(); this.push(this.y); this.idle(); break;
      case 0x8e: this.idle(); this.idle(); this.psw = this.pop(); break;
      case 0xae: this.idle(); this.idle(); this.a = this.pop(); break;
      case 0xce: this.idle(); this.idle(); this.x = this.pop(); break;
      case 0xee: this.idle(); this.idle(); this.y = this.pop(); break;
      // ── flag ops ──
      case 0x20: this.idle(); this.setFlag(FLAG_P, false); break; // CLRP
      case 0x40: this.idle(); this.setFlag(FLAG_P, true); break; // SETP
      case 0x60: this.idle(); this.setFlag(FLAG_C, false); break; // CLRC
      case 0x80: this.idle(); this.setFlag(FLAG_C, true); break; // SETC
      case 0xe0: this.idle(); this.psw &= ~(FLAG_V | FLAG_H); break; // CLRV
      case 0xed: this.idle(); this.idle(); this.psw ^= FLAG_C; break; // NOTC
      case 0xa0: this.idle(); this.idle(); this.setFlag(FLAG_I, true); break; // EI
      case 0xc0: this.idle(); this.idle(); this.setFlag(FLAG_I, false); break; // DI
      // ── halt ──
      case 0xef: for (let i = 0; i < 6; i++) this.idle(); this.sleeping = true; break; // SLEEP
      case 0xff: for (let i = 0; i < 6; i++) this.idle(); this.stopped = true; break; // STOP
      default: break;
    }
  }

  /** DIV YA,X — quotient to A, remainder to Y, with the hardware's overflow
   *  behaviour when the quotient exceeds 9 bits. */
  private div(): void {
    for (let i = 0; i < 11; i++) this.idle();
    const ya = (this.y << 8) | this.a;
    this.setFlag(FLAG_H, (this.x & 0xf) <= (this.y & 0xf));
    this.setFlag(FLAG_V, this.y >= this.x);
    if (this.y < this.x << 1) {
      this.a = this.x !== 0 ? (ya / this.x) & 0xff : 0xff;
      this.y = this.x !== 0 ? ya % this.x : this.a;
    } else {
      const denom = 256 - this.x;
      this.a = (255 - Math.floor((ya - (this.x << 9)) / denom)) & 0xff;
      this.y = (this.x + ((ya - (this.x << 9)) % denom)) & 0xff;
    }
    this.setNZ(this.a);
  }
}
