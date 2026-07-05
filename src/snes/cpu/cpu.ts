/**
 * WDC 65C816 CPU core.
 *
 * The SNES's CPU: a 16-bit 6502 descendant with runtime-switchable register
 * widths (the M and X status flags select 8- or 16-bit accumulator and index
 * operations per instruction), a 24-bit address space (data bank / program
 * bank registers + a relocatable direct page), a relocatable stack, working
 * BCD arithmetic, and a 6502-compatible emulation mode (E flag) with its own
 * page-wrap quirks.
 *
 * Every memory access goes through the bus and counts one cycle; internal
 * operations count via `idle()`. The core is validated against the
 * SingleStepTests 65816 vectors (`npm run test:snes-cpu`) — 20,000 cases per
 * opcode covering both modes with final state and cycle-level bus activity.
 *
 * Reference: fullsnes "SNES CPU" and the W65C816S datasheet.
 */

const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_D = 0x08;
const FLAG_X = 0x10; // index width (native); B flag position in emulation
const FLAG_M = 0x20; // accumulator width (native)
const FLAG_V = 0x40;
const FLAG_N = 0x80;

const VEC_NATIVE_COP = 0xffe4;
const VEC_NATIVE_BRK = 0xffe6;
const VEC_EMU_COP = 0xfff4;
const VEC_EMU_BRK = 0xfffe;

import { checkSnesPc } from "../debug/breakpoints.js";
import { notePopSnes, notePushSnes } from "../debug/call-stack.js";
import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

export interface SnesCpuBus {
  /** Master-cycle cost of one access to `addr` (6 fast / 8 slow / 12 joypad). */
  cost(addr: number): number;
  /** Read one byte from the 24-bit address space. */
  read(addr: number): number;
  /** Write one byte to the 24-bit address space. */
  write(addr: number, value: number): void;
}

export class Cpu65816 {
  /** Accumulator (full 16-bit C register; the M flag selects how much of it
   *  instructions touch — the high byte B survives 8-bit operations). */
  a = 0;
  x = 0;
  y = 0;
  /** Stack pointer (16-bit; emulation mode pins the high byte to $01). */
  s = 0x01fd;
  /** Direct-page base. */
  d = 0;
  pc = 0;
  /** Data bank (bank byte for absolute-addressed data). */
  dbr = 0;
  /** Program bank. */
  pbr = 0;
  p = FLAG_M | FLAG_X | FLAG_I;
  /** Emulation flag (not a P bit — swapped with carry via XCE). */
  e = 1;

  /** Cumulative MASTER cycles. Each bus access costs the region's speed
   *  (6 fast / 8 slow / 12 joypad, per the bus's cost map); internal
   *  operations cost 6. */
  cycles = 0;

  /** Master length of the last two CPU cycles of the just-finished
   *  instruction. The 65C816 samples its interrupt lines two CPU cycles
   *  before an instruction boundary; since cycle lengths vary, the host
   *  needs this to place the sample point in master-cycle time. */
  intSampleOffset = 12;
  private lastCycleCost = 6;
  private prevCycleCost = 6;

  stopped = false;
  waiting = false;

  /** Debugger hooks (PC breakpoints, call-stack notes) are wired to the
   *  console's main CPU; a coprocessor core (SA-1) runs with them off so
   *  its execution can't latch breakpoints or pollute the call stack. */
  debugHooks = true;

  /** Master-cycle cost of an internal (no-bus) cycle: 6 on the console
   *  CPU, 2 on the 10.74 MHz SA-1 core. */
  idleCost = 6;

  /** I flag as it stood when the last instruction STARTED — the 65C816
   *  samples the mask at the same early point as the interrupt lines, so
   *  CLI/SEI take effect one instruction late for IRQ recognition. */
  irqMaskAtStart = true;

  constructor(private readonly bus: SnesCpuBus) {}

  private addCycle(cost: number): void {
    this.cycles += cost;
    this.prevCycleCost = this.lastCycleCost;
    this.lastCycleCost = cost;
  }

  /** 8-bit accumulator/memory operations? */
  private get m8(): boolean {
    return this.e === 1 || (this.p & FLAG_M) !== 0;
  }

  /** 8-bit index operations? */
  private get x8(): boolean {
    return this.e === 1 || (this.p & FLAG_X) !== 0;
  }

  // ── bus primitives ────────────────────────────────────────────────────

  private read(addr: number): number {
    this.addCycle(this.bus.cost(addr & 0xffffff));
    return this.bus.read(addr & 0xffffff) & 0xff;
  }

  private write(addr: number, value: number): void {
    this.addCycle(this.bus.cost(addr & 0xffffff));
    this.bus.write(addr & 0xffffff, value & 0xff);
  }

  private idle(): void {
    this.addCycle(this.idleCost);
  }

  private fetch(): number {
    const v = this.read((this.pbr << 16) | this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    return this.fetch() | (this.fetch() << 8);
  }

  /** 16-bit data read; the 24-bit address increments across banks. */
  private read16(addr: number): number {
    return this.read(addr) | (this.read(addr + 1) << 8);
  }

  /** 16-bit read that wraps within bank 0 (direct page, stack). */
  private read16b0(addr: number): number {
    return this.read(addr & 0xffff) | (this.read((addr + 1) & 0xffff) << 8);
  }

  private write16(addr: number, v: number): void {
    this.write(addr, v & 0xff);
    this.write(addr + 1, v >> 8);
  }

  private write16b0(addr: number, v: number): void {
    this.write(addr & 0xffff, v & 0xff);
    this.write((addr + 1) & 0xffff, v >> 8);
  }

  // ── stack ─────────────────────────────────────────────────────────────

  private spDec(): void {
    this.s = (this.s - 1) & 0xffff;
    if (this.e) this.s = 0x0100 | (this.s & 0xff);
  }

  private spInc(): void {
    this.s = (this.s + 1) & 0xffff;
    if (this.e) this.s = 0x0100 | (this.s & 0xff);
  }

  private push8(v: number): void {
    this.write(this.s, v);
    this.spDec();
  }

  private push16(v: number): void {
    this.push8(v >> 8);
    this.push8(v & 0xff);
  }

  private pull8(): number {
    this.spInc();
    return this.read(this.s);
  }

  private pull16(): number {
    return this.pull8() | (this.pull8() << 8);
  }

  // The 65816-new stack opcodes (PEA/PEI/PER/PHB/PHD/PHK/PLB/PLD/JSL/RTL)
  // use full 16-bit stack arithmetic even in emulation mode — pushes can
  // write into page 0 — and the page-1 pin re-applies afterwards.

  private pushLong8(v: number): void {
    this.write(this.s, v);
    this.s = (this.s - 1) & 0xffff;
  }

  private pushLong16(v: number): void {
    this.pushLong8(v >> 8);
    this.pushLong8(v & 0xff);
  }

  private pullLong8(): number {
    this.s = (this.s + 1) & 0xffff;
    return this.read(this.s);
  }

  private pullLong16(): number {
    return this.pullLong8() | (this.pullLong8() << 8);
  }

  private repinStack(): void {
    if (this.e) this.s = 0x0100 | (this.s & 0xff);
  }

  // ── flags ─────────────────────────────────────────────────────────────

  private setNZ8(v: number): void {
    this.p = (this.p & ~(FLAG_N | FLAG_Z)) | (v & 0x80) | (v === 0 ? FLAG_Z : 0);
  }

  private setNZ16(v: number): void {
    this.p = (this.p & ~(FLAG_N | FLAG_Z)) | ((v >> 8) & 0x80) | (v === 0 ? FLAG_Z : 0);
  }

  private setNZ(v: number, is8: boolean): void {
    if (is8) this.setNZ8(v);
    else this.setNZ16(v);
  }

  private setFlag(mask: number, on: boolean): void {
    this.p = on ? this.p | mask : this.p & ~mask;
  }

  /** Writing P: emulation keeps M/X pinned; setting X truncates the index
   *  registers to 8 bits (the high bytes are physically cleared). */
  private setP(v: number): void {
    this.p = v & 0xff;
    if (this.e) this.p |= FLAG_M | FLAG_X;
    if (this.p & FLAG_X) {
      this.x &= 0xff;
      this.y &= 0xff;
    }
  }

  // ── addressing modes ──────────────────────────────────────────────────
  // Each returns an effective address. Direct-page and stack-relative
  // addresses are 16-bit (bank 0, wrapping); absolute/long are 24-bit
  // linear. `dataRead`/`dataWrite` pick the right wrap by address size.

  private amDp(): number {
    const off = this.fetch();
    if ((this.d & 0xff) !== 0) this.idle();
    return (this.d + off) & 0xffff;
  }

  private amDpIdx(reg: number): number {
    const off = this.fetch();
    if ((this.d & 0xff) !== 0) this.idle();
    this.idle();
    if (this.e && (this.d & 0xff) === 0) return (this.d & 0xff00) | ((off + reg) & 0xff);
    return (this.d + off + reg) & 0xffff;
  }

  /** Direct-page pointer fetch with the emulation-mode page-wrap quirk. */
  private dpPtr16(base: number): number {
    if (this.e && (this.d & 0xff) === 0) {
      const lo = this.read(base);
      const hi = this.read((base & 0xff00) | ((base + 1) & 0xff));
      return lo | (hi << 8);
    }
    return this.read16b0(base);
  }

  private amIndDp(): number {
    const base = this.amDp();
    return (this.dbr << 16) + this.dpPtr16(base);
  }

  private amIndDpX(): number {
    // In emulation mode the pointer's high-byte fetch wraps within the page
    // holding the low byte — regardless of DL (hardware-verified: gilyon
    // cputest-full 0024 DL=0 and 0027 DL=$1A both plant the high byte at the
    // wrapped address). The SingleStepTests 65816 vectors disagree here and
    // lose to silicon. The index ADD itself is full-width when DL!=0.
    const base = this.amDpIdx(this.x);
    if (this.e) {
      const lo = this.read(base);
      const hi = this.read((base & 0xff00) | ((base + 1) & 0xff));
      return (this.dbr << 16) + (lo | (hi << 8));
    }
    return (this.dbr << 16) + this.read16b0(base);
  }

  private amIndDpY(write: boolean): number {
    const base = this.amDp();
    const ptr = (this.dbr << 16) + this.dpPtr16(base);
    const eff = (ptr + this.y) & 0xffffff;
    if (write || !this.x8 || (ptr & 0xff00) !== (eff & 0xff00)) this.idle();
    return eff;
  }

  private amIndLongDp(): number {
    const base = this.amDp();
    const lo = this.read(base);
    const mid = this.read((base + 1) & 0xffff);
    const hi = this.read((base + 2) & 0xffff);
    return lo | (mid << 8) | (hi << 16);
  }

  private amIndLongDpY(): number {
    return (this.amIndLongDp() + this.y) & 0xffffff;
  }

  private amAbs(): number {
    return (this.dbr << 16) + this.fetch16();
  }

  private amAbsIdx(reg: number, write: boolean): number {
    const base = (this.dbr << 16) + this.fetch16();
    const eff = (base + reg) & 0xffffff;
    if (write || !this.x8 || (base & 0xff00) !== (eff & 0xff00)) this.idle();
    return eff;
  }

  private amLong(): number {
    return this.fetch16() | (this.fetch() << 16);
  }

  private amLongX(): number {
    return (this.amLong() + this.x) & 0xffffff;
  }

  private amSr(): number {
    const off = this.fetch();
    this.idle();
    return (this.s + off) & 0xffff;
  }

  private amSrIndY(): number {
    const base = this.amSr();
    const ptr = (this.dbr << 16) + this.read16b0(base);
    this.idle();
    return (ptr + this.y) & 0xffffff;
  }

  // ── data access by address width ──────────────────────────────────────
  // Addresses below 0x10000 from dp/sr modes live in bank 0 and wrap there;
  // 24-bit addresses increment linearly across banks.

  private load(addr: number, is8: boolean): number {
    if (is8) return this.read(addr);
    return addr < 0x10000 ? this.read16b0(addr) : this.read16(addr);
  }

  private store(addr: number, v: number, is8: boolean): void {
    if (is8) this.write(addr, v);
    else if (addr < 0x10000) this.write16b0(addr, v);
    else this.write16(addr, v);
  }

  private immM(): number {
    return this.m8 ? this.fetch() : this.fetch16();
  }

  private immX(): number {
    return this.x8 ? this.fetch() : this.fetch16();
  }

  // ── ALU ───────────────────────────────────────────────────────────────

  private setA(v: number): void {
    if (this.m8) {
      this.a = (this.a & 0xff00) | (v & 0xff);
      this.setNZ8(v & 0xff);
    } else {
      this.a = v & 0xffff;
      this.setNZ16(this.a);
    }
  }

  private aVal(): number {
    return this.m8 ? this.a & 0xff : this.a;
  }

  private ora(v: number): void {
    this.setA(this.aVal() | v);
  }

  private and(v: number): void {
    this.setA(this.aVal() & v);
  }

  private eor(v: number): void {
    this.setA(this.aVal() ^ v);
  }

  private adc(v: number): void {
    const carry = this.p & FLAG_C;
    if (this.p & FLAG_D) {
      this.adcDecimal(v, carry);
      return;
    }
    if (this.m8) {
      const av = this.a & 0xff;
      const r = av + v + carry;
      this.setFlag(FLAG_V, (~(av ^ v) & (av ^ r) & 0x80) !== 0);
      this.setFlag(FLAG_C, r > 0xff);
      this.setA(r & 0xff);
    } else {
      const r = this.a + v + carry;
      this.setFlag(FLAG_V, (~(this.a ^ v) & (this.a ^ r) & 0x8000) !== 0);
      this.setFlag(FLAG_C, r > 0xffff);
      this.setA(r & 0xffff);
    }
  }

  /** BCD addition, column at a time (2 nibbles when M=1, 4 when M=0). The V
   *  flag is sampled on the sum after the lower columns' decimal adjusts but
   *  before the top column's own adjust — the point where the silicon's
   *  binary adder has produced the top bit. */
  private adcDecimal(v: number, carry: number): void {
    const nibbles = this.m8 ? 2 : 4;
    const av = this.m8 ? this.a & 0xff : this.a;
    let r = 0;
    let c = carry;
    for (let i = 0; i < nibbles; i++) {
      const shift = i * 4;
      const mask = 0xf << shift;
      r = (av & mask) + (v & mask) + (c << shift) + (r & ((1 << shift) - 1));
      if (i === nibbles - 1) {
        const signBit = this.m8 ? 0x80 : 0x8000;
        this.setFlag(FLAG_V, (~(av ^ v) & (av ^ r) & signBit) !== 0);
      }
      if (r > (0xa << shift) - 1) r += 6 << shift;
      c = r > (0x10 << shift) - 1 ? 1 : 0;
    }
    this.setFlag(FLAG_C, c !== 0);
    this.setA(r & (this.m8 ? 0xff : 0xffff));
  }

  private sbc(v: number): void {
    if (this.p & FLAG_D) {
      this.sbcDecimal(v);
      return;
    }
    this.adc(this.m8 ? v ^ 0xff : v ^ 0xffff);
  }

  /** BCD subtraction — same column structure as {@link adcDecimal} with the
   *  operand inverted; columns whose binary sum fails to carry get the -6
   *  decimal correction. */
  private sbcDecimal(v: number): void {
    const nibbles = this.m8 ? 2 : 4;
    const av = this.m8 ? this.a & 0xff : this.a;
    const inv = (this.m8 ? v ^ 0xff : v ^ 0xffff) & (this.m8 ? 0xff : 0xffff);
    let r = 0;
    let c = this.p & FLAG_C;
    for (let i = 0; i < nibbles; i++) {
      const shift = i * 4;
      const mask = 0xf << shift;
      r = (av & mask) + (inv & mask) + (c << shift) + (r & ((1 << shift) - 1));
      if (i === nibbles - 1) {
        const signBit = this.m8 ? 0x80 : 0x8000;
        this.setFlag(FLAG_V, (~(av ^ inv) & (av ^ r) & signBit) !== 0);
      }
      if (r <= (0x10 << shift) - 1) r -= 6 << shift;
      c = r > (0x10 << shift) - 1 ? 1 : 0;
    }
    this.setFlag(FLAG_C, c !== 0);
    this.setA(r & (this.m8 ? 0xff : 0xffff));
  }

  private compare(reg: number, v: number, is8: boolean): void {
    const r = reg - v;
    this.setFlag(FLAG_C, r >= 0);
    this.setNZ(r & (is8 ? 0xff : 0xffff), is8);
  }

  private bitMem(v: number): void {
    const is8 = this.m8;
    const nBit = is8 ? 0x80 : 0x8000;
    const vBit = is8 ? 0x40 : 0x4000;
    this.setFlag(FLAG_N, (v & nBit) !== 0);
    this.setFlag(FLAG_V, (v & vBit) !== 0);
    this.setFlag(FLAG_Z, (v & this.aVal()) === 0);
  }

  // ── RMW helpers ───────────────────────────────────────────────────────

  private asl(v: number): number {
    const is8 = this.m8;
    this.setFlag(FLAG_C, (v & (is8 ? 0x80 : 0x8000)) !== 0);
    const r = (v << 1) & (is8 ? 0xff : 0xffff);
    this.setNZ(r, is8);
    return r;
  }

  private lsr(v: number): number {
    this.setFlag(FLAG_C, (v & 1) !== 0);
    const r = v >> 1;
    this.setNZ(r, this.m8);
    return r;
  }

  private rol(v: number): number {
    const is8 = this.m8;
    const carryIn = this.p & FLAG_C;
    this.setFlag(FLAG_C, (v & (is8 ? 0x80 : 0x8000)) !== 0);
    const r = ((v << 1) | carryIn) & (is8 ? 0xff : 0xffff);
    this.setNZ(r, is8);
    return r;
  }

  private ror(v: number): number {
    const is8 = this.m8;
    const carryIn = (this.p & FLAG_C) !== 0 ? (is8 ? 0x80 : 0x8000) : 0;
    this.setFlag(FLAG_C, (v & 1) !== 0);
    const r = (v >> 1) | carryIn;
    this.setNZ(r, is8);
    return r;
  }

  private inc(v: number): number {
    const r = (v + 1) & (this.m8 ? 0xff : 0xffff);
    this.setNZ(r, this.m8);
    return r;
  }

  private dec(v: number): number {
    const r = (v - 1) & (this.m8 ? 0xff : 0xffff);
    this.setNZ(r, this.m8);
    return r;
  }

  private tsb(v: number): number {
    this.setFlag(FLAG_Z, (v & this.aVal()) === 0);
    return v | this.aVal();
  }

  private trb(v: number): number {
    this.setFlag(FLAG_Z, (v & this.aVal()) === 0);
    return v & ~this.aVal();
  }

  /** Read-modify-write at `addr`: read, internal cycle, write back (16-bit
   *  writes come high byte first on this CPU). */
  private rmw(addr: number, fn: (v: number) => number): void {
    const is8 = this.m8;
    if (is8) {
      const v = this.read(addr);
      this.idle();
      this.write(addr, fn(v));
    } else {
      const bank0 = addr < 0x10000;
      const lo = this.read(addr);
      const hiAddr = bank0 ? (addr + 1) & 0xffff : addr + 1;
      const hi = this.read(hiAddr);
      this.idle();
      const r = fn(lo | (hi << 8));
      this.write(hiAddr, r >> 8);
      this.write(addr, r & 0xff);
    }
  }

  // ── control flow ──────────────────────────────────────────────────────

  private branch(taken: boolean): void {
    const off = this.fetch();
    if (!taken) return;
    this.idle();
    const target = (this.pc + ((off << 24) >> 24)) & 0xffff;
    if (this.e && (target & 0xff00) !== (this.pc & 0xff00)) this.idle();
    this.pc = target;
  }

  private interrupt(vector: number, isBrk: boolean): void {
    // BRK/COP carry a signature byte the CPU fetches and ignores.
    this.fetch();
    if (this.e) {
      this.push16(this.pc);
      this.push8(this.p | (isBrk ? FLAG_X : 0)); // B flag set in the pushed copy
    } else {
      this.push8(this.pbr);
      this.push16(this.pc);
      this.push8(this.p);
    }
    this.p = (this.p | FLAG_I) & ~FLAG_D;
    this.pbr = 0;
    this.pc = this.read16(vector);
  }

  // ── execution ─────────────────────────────────────────────────────────

  /** Hardware interrupt entry (no signature byte, B clear in the pushed P).
   *  NMI wakes WAI; IRQ entry additionally requires the I flag clear (the
   *  caller checks the line; this services unconditionally). */
  hwInterrupt(vector: number): void {
    this.waiting = false;
    this.idle();
    this.idle();
    if (this.e) {
      this.push16(this.pc);
      this.push8(this.p & ~FLAG_X);
    } else {
      this.push8(this.pbr);
      this.push16(this.pc);
      this.push8(this.p);
    }
    this.p = (this.p | FLAG_I) & ~FLAG_D;
    this.pbr = 0;
    this.pc = this.read16(vector);
  }

  get irqDisabled(): boolean {
    return (this.p & FLAG_I) !== 0;
  }

  serialize(w: SnesStateWriter): void {
    w.u16(this.a);
    w.u16(this.x);
    w.u16(this.y);
    w.u16(this.s);
    w.u16(this.d);
    w.u16(this.pc);
    w.u8(this.dbr);
    w.u8(this.pbr);
    w.u8(this.p);
    w.u8(this.e);
    w.f64(this.cycles);
    w.bool(this.stopped);
    w.bool(this.waiting);
  }

  deserialize(r: SnesStateReader): void {
    this.a = r.u16();
    this.x = r.u16();
    this.y = r.u16();
    this.s = r.u16();
    this.d = r.u16();
    this.pc = r.u16();
    this.dbr = r.u8();
    this.pbr = r.u8();
    this.p = r.u8();
    this.e = r.u8();
    this.cycles = r.f64();
    this.stopped = r.bool();
    this.waiting = r.bool();
  }

  /** Execute one instruction. */
  step(): void {
    this.irqMaskAtStart = this.irqDisabled;
    if (this.stopped || this.waiting) {
      this.idle();
      this.intSampleOffset = this.lastCycleCost + this.prevCycleCost;
      return;
    }
    // PC breakpoint: latches a hit without executing (and without
    // consuming cycles — the surrounding frame loop exits on
    // peekSnesHit so the stalled `cycles` counter can't spin it
    // forever). The armed-PC logic inside the registry lets a Step
    // press advance past the breakpoint instead of re-triggering it.
    if (this.debugHooks && checkSnesPc((this.pbr << 16) | this.pc)) return;
    // Structural emulation-mode invariants (not just conventions): the S
    // high byte is hard-wired to $01 and M/X read as set.
    if (this.e) {
      this.s = 0x0100 | (this.s & 0xff);
      this.p |= FLAG_M | FLAG_X;
    }
    const op = this.fetch();
    this.execute(op);
    this.intSampleOffset = this.lastCycleCost + this.prevCycleCost;
  }

  // prettier-ignore
  private execute(op: number): void {
    switch (op) {
      // ORA
      case 0x01: this.ora(this.load(this.amIndDpX(), this.m8)); break;
      case 0x03: this.ora(this.load(this.amSr(), this.m8)); break;
      case 0x05: this.ora(this.load(this.amDp(), this.m8)); break;
      case 0x07: this.ora(this.load(this.amIndLongDp(), this.m8)); break;
      case 0x09: this.ora(this.immM()); break;
      case 0x0d: this.ora(this.load(this.amAbs(), this.m8)); break;
      case 0x0f: this.ora(this.load(this.amLong(), this.m8)); break;
      case 0x11: this.ora(this.load(this.amIndDpY(false), this.m8)); break;
      case 0x12: this.ora(this.load(this.amIndDp(), this.m8)); break;
      case 0x13: this.ora(this.load(this.amSrIndY(), this.m8)); break;
      case 0x15: this.ora(this.load(this.amDpIdx(this.x), this.m8)); break;
      case 0x17: this.ora(this.load(this.amIndLongDpY(), this.m8)); break;
      case 0x19: this.ora(this.load(this.amAbsIdx(this.y, false), this.m8)); break;
      case 0x1d: this.ora(this.load(this.amAbsIdx(this.x, false), this.m8)); break;
      case 0x1f: this.ora(this.load(this.amLongX(), this.m8)); break;
      // AND
      case 0x21: this.and(this.load(this.amIndDpX(), this.m8)); break;
      case 0x23: this.and(this.load(this.amSr(), this.m8)); break;
      case 0x25: this.and(this.load(this.amDp(), this.m8)); break;
      case 0x27: this.and(this.load(this.amIndLongDp(), this.m8)); break;
      case 0x29: this.and(this.immM()); break;
      case 0x2d: this.and(this.load(this.amAbs(), this.m8)); break;
      case 0x2f: this.and(this.load(this.amLong(), this.m8)); break;
      case 0x31: this.and(this.load(this.amIndDpY(false), this.m8)); break;
      case 0x32: this.and(this.load(this.amIndDp(), this.m8)); break;
      case 0x33: this.and(this.load(this.amSrIndY(), this.m8)); break;
      case 0x35: this.and(this.load(this.amDpIdx(this.x), this.m8)); break;
      case 0x37: this.and(this.load(this.amIndLongDpY(), this.m8)); break;
      case 0x39: this.and(this.load(this.amAbsIdx(this.y, false), this.m8)); break;
      case 0x3d: this.and(this.load(this.amAbsIdx(this.x, false), this.m8)); break;
      case 0x3f: this.and(this.load(this.amLongX(), this.m8)); break;
      // EOR
      case 0x41: this.eor(this.load(this.amIndDpX(), this.m8)); break;
      case 0x43: this.eor(this.load(this.amSr(), this.m8)); break;
      case 0x45: this.eor(this.load(this.amDp(), this.m8)); break;
      case 0x47: this.eor(this.load(this.amIndLongDp(), this.m8)); break;
      case 0x49: this.eor(this.immM()); break;
      case 0x4d: this.eor(this.load(this.amAbs(), this.m8)); break;
      case 0x4f: this.eor(this.load(this.amLong(), this.m8)); break;
      case 0x51: this.eor(this.load(this.amIndDpY(false), this.m8)); break;
      case 0x52: this.eor(this.load(this.amIndDp(), this.m8)); break;
      case 0x53: this.eor(this.load(this.amSrIndY(), this.m8)); break;
      case 0x55: this.eor(this.load(this.amDpIdx(this.x), this.m8)); break;
      case 0x57: this.eor(this.load(this.amIndLongDpY(), this.m8)); break;
      case 0x59: this.eor(this.load(this.amAbsIdx(this.y, false), this.m8)); break;
      case 0x5d: this.eor(this.load(this.amAbsIdx(this.x, false), this.m8)); break;
      case 0x5f: this.eor(this.load(this.amLongX(), this.m8)); break;
      // ADC
      case 0x61: this.adc(this.load(this.amIndDpX(), this.m8)); break;
      case 0x63: this.adc(this.load(this.amSr(), this.m8)); break;
      case 0x65: this.adc(this.load(this.amDp(), this.m8)); break;
      case 0x67: this.adc(this.load(this.amIndLongDp(), this.m8)); break;
      case 0x69: this.adc(this.immM()); break;
      case 0x6d: this.adc(this.load(this.amAbs(), this.m8)); break;
      case 0x6f: this.adc(this.load(this.amLong(), this.m8)); break;
      case 0x71: this.adc(this.load(this.amIndDpY(false), this.m8)); break;
      case 0x72: this.adc(this.load(this.amIndDp(), this.m8)); break;
      case 0x73: this.adc(this.load(this.amSrIndY(), this.m8)); break;
      case 0x75: this.adc(this.load(this.amDpIdx(this.x), this.m8)); break;
      case 0x77: this.adc(this.load(this.amIndLongDpY(), this.m8)); break;
      case 0x79: this.adc(this.load(this.amAbsIdx(this.y, false), this.m8)); break;
      case 0x7d: this.adc(this.load(this.amAbsIdx(this.x, false), this.m8)); break;
      case 0x7f: this.adc(this.load(this.amLongX(), this.m8)); break;
      // SBC
      case 0xe1: this.sbc(this.load(this.amIndDpX(), this.m8)); break;
      case 0xe3: this.sbc(this.load(this.amSr(), this.m8)); break;
      case 0xe5: this.sbc(this.load(this.amDp(), this.m8)); break;
      case 0xe7: this.sbc(this.load(this.amIndLongDp(), this.m8)); break;
      case 0xe9: this.sbc(this.immM()); break;
      case 0xed: this.sbc(this.load(this.amAbs(), this.m8)); break;
      case 0xef: this.sbc(this.load(this.amLong(), this.m8)); break;
      case 0xf1: this.sbc(this.load(this.amIndDpY(false), this.m8)); break;
      case 0xf2: this.sbc(this.load(this.amIndDp(), this.m8)); break;
      case 0xf3: this.sbc(this.load(this.amSrIndY(), this.m8)); break;
      case 0xf5: this.sbc(this.load(this.amDpIdx(this.x), this.m8)); break;
      case 0xf7: this.sbc(this.load(this.amIndLongDpY(), this.m8)); break;
      case 0xf9: this.sbc(this.load(this.amAbsIdx(this.y, false), this.m8)); break;
      case 0xfd: this.sbc(this.load(this.amAbsIdx(this.x, false), this.m8)); break;
      case 0xff: this.sbc(this.load(this.amLongX(), this.m8)); break;
      // CMP
      case 0xc1: this.compare(this.aVal(), this.load(this.amIndDpX(), this.m8), this.m8); break;
      case 0xc3: this.compare(this.aVal(), this.load(this.amSr(), this.m8), this.m8); break;
      case 0xc5: this.compare(this.aVal(), this.load(this.amDp(), this.m8), this.m8); break;
      case 0xc7: this.compare(this.aVal(), this.load(this.amIndLongDp(), this.m8), this.m8); break;
      case 0xc9: this.compare(this.aVal(), this.immM(), this.m8); break;
      case 0xcd: this.compare(this.aVal(), this.load(this.amAbs(), this.m8), this.m8); break;
      case 0xcf: this.compare(this.aVal(), this.load(this.amLong(), this.m8), this.m8); break;
      case 0xd1: this.compare(this.aVal(), this.load(this.amIndDpY(false), this.m8), this.m8); break;
      case 0xd2: this.compare(this.aVal(), this.load(this.amIndDp(), this.m8), this.m8); break;
      case 0xd3: this.compare(this.aVal(), this.load(this.amSrIndY(), this.m8), this.m8); break;
      case 0xd5: this.compare(this.aVal(), this.load(this.amDpIdx(this.x), this.m8), this.m8); break;
      case 0xd7: this.compare(this.aVal(), this.load(this.amIndLongDpY(), this.m8), this.m8); break;
      case 0xd9: this.compare(this.aVal(), this.load(this.amAbsIdx(this.y, false), this.m8), this.m8); break;
      case 0xdd: this.compare(this.aVal(), this.load(this.amAbsIdx(this.x, false), this.m8), this.m8); break;
      case 0xdf: this.compare(this.aVal(), this.load(this.amLongX(), this.m8), this.m8); break;
      // CPX / CPY
      case 0xe0: this.compare(this.x, this.immX(), this.x8); break;
      case 0xe4: this.compare(this.x, this.load(this.amDp(), this.x8), this.x8); break;
      case 0xec: this.compare(this.x, this.load(this.amAbs(), this.x8), this.x8); break;
      case 0xc0: this.compare(this.y, this.immX(), this.x8); break;
      case 0xc4: this.compare(this.y, this.load(this.amDp(), this.x8), this.x8); break;
      case 0xcc: this.compare(this.y, this.load(this.amAbs(), this.x8), this.x8); break;
      // BIT
      case 0x24: this.bitMem(this.load(this.amDp(), this.m8)); break;
      case 0x2c: this.bitMem(this.load(this.amAbs(), this.m8)); break;
      case 0x34: this.bitMem(this.load(this.amDpIdx(this.x), this.m8)); break;
      case 0x3c: this.bitMem(this.load(this.amAbsIdx(this.x, false), this.m8)); break;
      case 0x89: this.setFlag(FLAG_Z, (this.immM() & this.aVal()) === 0); break;
      // LDA
      case 0xa1: this.setA(this.load(this.amIndDpX(), this.m8)); break;
      case 0xa3: this.setA(this.load(this.amSr(), this.m8)); break;
      case 0xa5: this.setA(this.load(this.amDp(), this.m8)); break;
      case 0xa7: this.setA(this.load(this.amIndLongDp(), this.m8)); break;
      case 0xa9: this.setA(this.immM()); break;
      case 0xad: this.setA(this.load(this.amAbs(), this.m8)); break;
      case 0xaf: this.setA(this.load(this.amLong(), this.m8)); break;
      case 0xb1: this.setA(this.load(this.amIndDpY(false), this.m8)); break;
      case 0xb2: this.setA(this.load(this.amIndDp(), this.m8)); break;
      case 0xb3: this.setA(this.load(this.amSrIndY(), this.m8)); break;
      case 0xb5: this.setA(this.load(this.amDpIdx(this.x), this.m8)); break;
      case 0xb7: this.setA(this.load(this.amIndLongDpY(), this.m8)); break;
      case 0xb9: this.setA(this.load(this.amAbsIdx(this.y, false), this.m8)); break;
      case 0xbd: this.setA(this.load(this.amAbsIdx(this.x, false), this.m8)); break;
      case 0xbf: this.setA(this.load(this.amLongX(), this.m8)); break;
      // LDX / LDY
      case 0xa2: this.x = this.immX(); this.setNZ(this.x, this.x8); break;
      case 0xa6: this.x = this.load(this.amDp(), this.x8); this.setNZ(this.x, this.x8); break;
      case 0xae: this.x = this.load(this.amAbs(), this.x8); this.setNZ(this.x, this.x8); break;
      case 0xb6: this.x = this.load(this.amDpIdx(this.y), this.x8); this.setNZ(this.x, this.x8); break;
      case 0xbe: this.x = this.load(this.amAbsIdx(this.y, false), this.x8); this.setNZ(this.x, this.x8); break;
      case 0xa0: this.y = this.immX(); this.setNZ(this.y, this.x8); break;
      case 0xa4: this.y = this.load(this.amDp(), this.x8); this.setNZ(this.y, this.x8); break;
      case 0xac: this.y = this.load(this.amAbs(), this.x8); this.setNZ(this.y, this.x8); break;
      case 0xb4: this.y = this.load(this.amDpIdx(this.x), this.x8); this.setNZ(this.y, this.x8); break;
      case 0xbc: this.y = this.load(this.amAbsIdx(this.x, false), this.x8); this.setNZ(this.y, this.x8); break;
      // STA
      case 0x81: this.store(this.amIndDpX(), this.aVal(), this.m8); break;
      case 0x83: this.store(this.amSr(), this.aVal(), this.m8); break;
      case 0x85: this.store(this.amDp(), this.aVal(), this.m8); break;
      case 0x87: this.store(this.amIndLongDp(), this.aVal(), this.m8); break;
      case 0x8d: this.store(this.amAbs(), this.aVal(), this.m8); break;
      case 0x8f: this.store(this.amLong(), this.aVal(), this.m8); break;
      case 0x91: this.store(this.amIndDpY(true), this.aVal(), this.m8); break;
      case 0x92: this.store(this.amIndDp(), this.aVal(), this.m8); break;
      case 0x93: this.store(this.amSrIndY(), this.aVal(), this.m8); break;
      case 0x95: this.store(this.amDpIdx(this.x), this.aVal(), this.m8); break;
      case 0x97: this.store(this.amIndLongDpY(), this.aVal(), this.m8); break;
      case 0x99: this.store(this.amAbsIdx(this.y, true), this.aVal(), this.m8); break;
      case 0x9d: this.store(this.amAbsIdx(this.x, true), this.aVal(), this.m8); break;
      case 0x9f: this.store(this.amLongX(), this.aVal(), this.m8); break;
      // STX / STY / STZ
      case 0x86: this.store(this.amDp(), this.x, this.x8); break;
      case 0x8e: this.store(this.amAbs(), this.x, this.x8); break;
      case 0x96: this.store(this.amDpIdx(this.y), this.x, this.x8); break;
      case 0x84: this.store(this.amDp(), this.y, this.x8); break;
      case 0x8c: this.store(this.amAbs(), this.y, this.x8); break;
      case 0x94: this.store(this.amDpIdx(this.x), this.y, this.x8); break;
      case 0x64: this.store(this.amDp(), 0, this.m8); break;
      case 0x74: this.store(this.amDpIdx(this.x), 0, this.m8); break;
      case 0x9c: this.store(this.amAbs(), 0, this.m8); break;
      case 0x9e: this.store(this.amAbsIdx(this.x, true), 0, this.m8); break;
      // RMW memory
      case 0x06: this.rmw(this.amDp(), (v) => this.asl(v)); break;
      case 0x0e: this.rmw(this.amAbs(), (v) => this.asl(v)); break;
      case 0x16: this.rmw(this.amDpIdx(this.x), (v) => this.asl(v)); break;
      case 0x1e: this.rmw(this.amAbsIdx(this.x, true), (v) => this.asl(v)); break;
      case 0x46: this.rmw(this.amDp(), (v) => this.lsr(v)); break;
      case 0x4e: this.rmw(this.amAbs(), (v) => this.lsr(v)); break;
      case 0x56: this.rmw(this.amDpIdx(this.x), (v) => this.lsr(v)); break;
      case 0x5e: this.rmw(this.amAbsIdx(this.x, true), (v) => this.lsr(v)); break;
      case 0x26: this.rmw(this.amDp(), (v) => this.rol(v)); break;
      case 0x2e: this.rmw(this.amAbs(), (v) => this.rol(v)); break;
      case 0x36: this.rmw(this.amDpIdx(this.x), (v) => this.rol(v)); break;
      case 0x3e: this.rmw(this.amAbsIdx(this.x, true), (v) => this.rol(v)); break;
      case 0x66: this.rmw(this.amDp(), (v) => this.ror(v)); break;
      case 0x6e: this.rmw(this.amAbs(), (v) => this.ror(v)); break;
      case 0x76: this.rmw(this.amDpIdx(this.x), (v) => this.ror(v)); break;
      case 0x7e: this.rmw(this.amAbsIdx(this.x, true), (v) => this.ror(v)); break;
      case 0xc6: this.rmw(this.amDp(), (v) => this.dec(v)); break;
      case 0xce: this.rmw(this.amAbs(), (v) => this.dec(v)); break;
      case 0xd6: this.rmw(this.amDpIdx(this.x), (v) => this.dec(v)); break;
      case 0xde: this.rmw(this.amAbsIdx(this.x, true), (v) => this.dec(v)); break;
      case 0xe6: this.rmw(this.amDp(), (v) => this.inc(v)); break;
      case 0xee: this.rmw(this.amAbs(), (v) => this.inc(v)); break;
      case 0xf6: this.rmw(this.amDpIdx(this.x), (v) => this.inc(v)); break;
      case 0xfe: this.rmw(this.amAbsIdx(this.x, true), (v) => this.inc(v)); break;
      case 0x04: this.rmw(this.amDp(), (v) => this.tsb(v)); break;
      case 0x0c: this.rmw(this.amAbs(), (v) => this.tsb(v)); break;
      case 0x14: this.rmw(this.amDp(), (v) => this.trb(v)); break;
      case 0x1c: this.rmw(this.amAbs(), (v) => this.trb(v)); break;
      // accumulator RMW
      case 0x0a: this.idle(); this.setA(this.asl(this.aVal())); break;
      case 0x4a: this.idle(); this.setA(this.lsr(this.aVal())); break;
      case 0x2a: this.idle(); this.setA(this.rol(this.aVal())); break;
      case 0x6a: this.idle(); this.setA(this.ror(this.aVal())); break;
      case 0x1a: this.idle(); this.setA(this.inc(this.aVal())); break;
      case 0x3a: this.idle(); this.setA(this.dec(this.aVal())); break;
      // index inc/dec
      case 0xe8: this.idle(); this.x = (this.x + 1) & (this.x8 ? 0xff : 0xffff); this.setNZ(this.x, this.x8); break;
      case 0xca: this.idle(); this.x = (this.x - 1) & (this.x8 ? 0xff : 0xffff); this.setNZ(this.x, this.x8); break;
      case 0xc8: this.idle(); this.y = (this.y + 1) & (this.x8 ? 0xff : 0xffff); this.setNZ(this.y, this.x8); break;
      case 0x88: this.idle(); this.y = (this.y - 1) & (this.x8 ? 0xff : 0xffff); this.setNZ(this.y, this.x8); break;
      // branches
      case 0x10: this.branch((this.p & FLAG_N) === 0); break;
      case 0x30: this.branch((this.p & FLAG_N) !== 0); break;
      case 0x50: this.branch((this.p & FLAG_V) === 0); break;
      case 0x70: this.branch((this.p & FLAG_V) !== 0); break;
      case 0x90: this.branch((this.p & FLAG_C) === 0); break;
      case 0xb0: this.branch((this.p & FLAG_C) !== 0); break;
      case 0xd0: this.branch((this.p & FLAG_Z) === 0); break;
      case 0xf0: this.branch((this.p & FLAG_Z) !== 0); break;
      case 0x80: this.branch(true); break;
      case 0x82: { const off = this.fetch16(); this.idle(); this.pc = (this.pc + ((off << 16) >> 16)) & 0xffff; break; } // BRL
      // jumps / calls
      case 0x4c: this.pc = this.fetch16(); break;
      case 0x5c: { const t = this.amLong(); this.pc = t & 0xffff; this.pbr = t >> 16; break; } // JML long
      case 0x6c: { const ptr = this.fetch16(); this.pc = this.read16b0(ptr); break; } // JMP (abs)
      case 0x7c: { const ptr = this.fetch16(); this.idle(); const eff = (this.pbr << 16) | ((ptr + this.x) & 0xffff); this.pc = this.read(eff) | (this.read((this.pbr << 16) | ((eff + 1) & 0xffff)) << 8); break; } // JMP (abs,X)
      case 0xdc: { const ptr = this.fetch16(); const t = this.read16b0(ptr) | (this.read((ptr + 2) & 0xffff) << 16); this.pc = t & 0xffff; this.pbr = t >> 16; break; } // JML (abs)
      case 0x20: { const from = (this.pbr << 16) | ((this.pc - 1) & 0xffff); const target = this.fetch16(); this.idle(); this.push16((this.pc - 1) & 0xffff); if (this.debugHooks) notePushSnes({ from, to: (this.pbr << 16) | target, e: this.e, kind: "jsr" }); this.pc = target; break; } // JSR abs
      case 0xfc: { // JSR (abs,X)
        const from = (this.pbr << 16) | ((this.pc - 1) & 0xffff);
        const lo = this.fetch();
        // 65816-new instruction: 16-bit stack arithmetic even in E-mode
        // (the pushes walk out of page 1; S re-pins after) — gilyon
        // cputest-full 0277 plants the return address at $0100/$00FF.
        this.pushLong16(this.pc & 0xffff); // return address = last operand byte's PC
        const hi = this.fetch();
        this.idle();
        const ptr = (this.pbr << 16) | (((lo | (hi << 8)) + this.x) & 0xffff);
        this.pc = this.read(ptr) | (this.read((this.pbr << 16) | ((ptr + 1) & 0xffff)) << 8);
        this.repinStack();
        if (this.debugHooks) notePushSnes({ from, to: (this.pbr << 16) | this.pc, e: this.e, kind: "jsr" });
        break;
      }
      case 0x22: { // JSL long
        const from = (this.pbr << 16) | ((this.pc - 1) & 0xffff);
        const lo = this.fetch();
        const mid = this.fetch();
        this.pushLong8(this.pbr);
        this.idle();
        const bank = this.fetch();
        this.pushLong16((this.pc - 1) & 0xffff);
        this.repinStack();
        this.pc = lo | (mid << 8);
        this.pbr = bank;
        if (this.debugHooks) notePushSnes({ from, to: (this.pbr << 16) | this.pc, e: this.e, kind: "jsl" });
        break;
      }
      case 0x60: this.idle(); this.idle(); this.pc = (this.pull16() + 1) & 0xffff; this.idle(); if (this.debugHooks) notePopSnes(); break; // RTS
      case 0x6b: this.idle(); this.idle(); this.pc = (this.pullLong16() + 1) & 0xffff; this.pbr = this.pullLong8(); this.repinStack(); if (this.debugHooks) notePopSnes(); break; // RTL
      case 0x40: { // RTI
        this.idle(); this.idle();
        this.setP(this.pull8());
        this.pc = this.pull16();
        if (!this.e) this.pbr = this.pull8();
        break;
      }
      case 0x00: this.interrupt(this.e ? VEC_EMU_BRK : VEC_NATIVE_BRK, true); break;
      case 0x02: this.interrupt(this.e ? VEC_EMU_COP : VEC_NATIVE_COP, false); break;
      // stack ops
      case 0x48: this.idle(); if (this.m8) this.push8(this.a & 0xff); else this.push16(this.a); break; // PHA
      case 0xda: this.idle(); if (this.x8) this.push8(this.x); else this.push16(this.x); break; // PHX
      case 0x5a: this.idle(); if (this.x8) this.push8(this.y); else this.push16(this.y); break; // PHY
      case 0x08: this.idle(); this.push8(this.e ? this.p | FLAG_X : this.p); break; // PHP (B set in emulation)
      case 0x8b: this.idle(); this.pushLong8(this.dbr); this.repinStack(); break; // PHB
      case 0x4b: this.idle(); this.pushLong8(this.pbr); this.repinStack(); break; // PHK
      case 0x0b: this.idle(); this.pushLong16(this.d); this.repinStack(); break; // PHD
      case 0x68: this.idle(); this.idle(); this.setA(this.m8 ? this.pull8() : this.pull16()); break; // PLA
      case 0xfa: this.idle(); this.idle(); this.x = this.x8 ? this.pull8() : this.pull16(); this.setNZ(this.x, this.x8); break; // PLX
      case 0x7a: this.idle(); this.idle(); this.y = this.x8 ? this.pull8() : this.pull16(); this.setNZ(this.y, this.x8); break; // PLY
      case 0x28: this.idle(); this.idle(); this.setP(this.pull8()); break; // PLP
      case 0xab: this.idle(); this.idle(); this.dbr = this.pullLong8(); this.setNZ8(this.dbr); this.repinStack(); break; // PLB
      case 0x2b: this.idle(); this.idle(); this.d = this.pullLong16(); this.setNZ16(this.d); this.repinStack(); break; // PLD
      case 0xf4: this.pushLong16(this.fetch16()); this.repinStack(); break; // PEA
      // PEI is 65816-new: its pointer read crosses pages even when E=1/DL=0
      case 0xd4: this.pushLong16(this.read16b0(this.amDp())); this.repinStack(); break; // PEI
      case 0x62: { const off = this.fetch16(); this.idle(); this.pushLong16((this.pc + off) & 0xffff); this.repinStack(); break; } // PER
      // flag ops
      case 0x18: this.idle(); this.setFlag(FLAG_C, false); break;
      case 0x38: this.idle(); this.setFlag(FLAG_C, true); break;
      case 0x58: this.idle(); this.setFlag(FLAG_I, false); break;
      case 0x78: this.idle(); this.setFlag(FLAG_I, true); break;
      case 0xd8: this.idle(); this.setFlag(FLAG_D, false); break;
      case 0xf8: this.idle(); this.setFlag(FLAG_D, true); break;
      case 0xb8: this.idle(); this.setFlag(FLAG_V, false); break;
      case 0xc2: { const mask = this.fetch(); this.idle(); this.setP(this.p & ~mask); break; } // REP
      case 0xe2: { const mask = this.fetch(); this.idle(); this.setP(this.p | mask); break; } // SEP
      // transfers
      case 0xaa: this.idle(); this.x = this.x8 ? this.a & 0xff : this.a; this.setNZ(this.x, this.x8); break; // TAX
      case 0xa8: this.idle(); this.y = this.x8 ? this.a & 0xff : this.a; this.setNZ(this.y, this.x8); break; // TAY
      case 0x8a: this.idle(); this.setA(this.m8 ? this.x & 0xff : this.x); break; // TXA
      case 0x98: this.idle(); this.setA(this.m8 ? this.y & 0xff : this.y); break; // TYA
      case 0x9b: this.idle(); this.y = this.x8 ? this.x & 0xff : this.x; this.setNZ(this.y, this.x8); break; // TXY
      case 0xbb: this.idle(); this.x = this.x8 ? this.y & 0xff : this.y; this.setNZ(this.x, this.x8); break; // TYX
      case 0x9a: this.idle(); this.s = this.e ? 0x0100 | (this.x & 0xff) : this.x; break; // TXS
      case 0xba: this.idle(); this.x = this.x8 ? this.s & 0xff : this.s; this.setNZ(this.x, this.x8); break; // TSX
      case 0x1b: this.idle(); this.s = this.e ? 0x0100 | (this.a & 0xff) : this.a; break; // TCS
      case 0x3b: this.idle(); this.a = this.s; this.setNZ16(this.a); break; // TSC
      case 0x5b: this.idle(); this.d = this.a; this.setNZ16(this.d); break; // TCD
      case 0x7b: this.idle(); this.a = this.d; this.setNZ16(this.a); break; // TDC
      case 0xeb: this.idle(); this.idle(); this.a = ((this.a & 0xff) << 8) | (this.a >> 8); this.setNZ8(this.a & 0xff); break; // XBA
      case 0xfb: { // XCE
        this.idle();
        const oldC = this.p & FLAG_C;
        this.setFlag(FLAG_C, this.e === 1);
        this.e = oldC;
        if (this.e) {
          this.p |= FLAG_M | FLAG_X;
          this.x &= 0xff;
          this.y &= 0xff;
          this.s = 0x0100 | (this.s & 0xff);
        }
        break;
      }
      // block moves — one byte per step(); PC rewinds until the count runs out
      case 0x54: case 0x44: { // MVN / MVP
        const dstBank = this.fetch();
        const srcBank = this.fetch();
        this.dbr = dstBank;
        const v = this.read((srcBank << 16) | (this.x8 ? this.x & 0xff : this.x));
        this.write((dstBank << 16) | (this.x8 ? this.y & 0xff : this.y), v);
        this.idle(); this.idle();
        const delta = op === 0x54 ? 1 : -1;
        const idxMask = this.x8 ? 0xff : 0xffff;
        this.x = (this.x + delta) & idxMask;
        this.y = (this.y + delta) & idxMask;
        this.a = (this.a - 1) & 0xffff;
        if (this.a !== 0xffff) this.pc = (this.pc - 3) & 0xffff;
        break;
      }
      // misc
      case 0xea: this.idle(); break; // NOP
      case 0x42: this.fetch(); break; // WDM
      case 0xcb: this.idle(); this.idle(); this.idle(); this.waiting = true; break; // WAI
      case 0xdb: this.idle(); this.idle(); this.idle(); this.stopped = true; break; // STP
      default: break;
    }
  }
}
