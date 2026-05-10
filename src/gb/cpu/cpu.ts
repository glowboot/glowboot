import type { APU } from "../apu/apu.js";
import { checkPc } from "../debug/breakpoints.js";
import { notePop, notePush } from "../debug/call-stack.js";
import { INTERRUPT_VECTORS, type InterruptController } from "../memory/interrupts.js";
import type { MMU } from "../memory/mmu.js";
import type { StateReader, StateWriter } from "../serialization/serialization.js";
import type { Timer } from "../timer/timer.js";
import { Registers } from "./registers.js";

/**
 * Sharp LR35902 CPU — the Game Boy's processor.
 *
 * All public/private methods return the number of M-cycles consumed
 * (1 M-cycle = 4 clock cycles = ~1 µs at 4.194304 MHz).
 *
 * Instruction timing follows the Pan Docs / Game Boy CPU Manual.
 */
export class CPU {
  readonly regs: Registers;

  /** Interrupt Master Enable */
  ime = false;
  /** IME is set one instruction after EI executes */
  private imeScheduled = false;
  halted = false;
  stopped = false;

  /**
   * DMG HALT bug: when HALT executes with IME=0 and a pending interrupt is
   * already set (IE & IF & 0x1F != 0), the CPU does *not* halt — but the
   * subsequent instruction fetch fails to increment PC, so the next byte is
   * read twice. Flag is set by the HALT handler, consumed by `fetchByte`.
   */
  private haltBug = false;

  /** CGB double-speed mode (KEY1 bit 7). CPU runs at 2× clock when true. */
  doubleSpeed = false;
  /** KEY1 bit 0 — set by the game; consumed by the next STOP to flip speed. */
  private key1Armed = false;

  /**
   * M-cycles already ticked through the timer via bus accesses during the
   * current step(). `finishTicks` tops up any remainder (internal cycles)
   * at end of step so the timer advances by exactly the instruction's
   * total M-cycle count per step. Per-access ticking is what makes the
   * mem_timing test pass — a read of TIMA has to reflect the timer state
   * at the bus-cycle it happens on, not at instruction boundary.
   */
  private ticksThisInstr = 0;

  /** PC snapshot at the start of the current `execute` — used by the
   *  debugger call-stack tracker to record the address of the CALL/RST
   *  that pushed each frame. Zero overhead (single field write per step). */
  private opPc = 0;

  constructor(
    private readonly mmu: MMU,
    private readonly interrupts: InterruptController,
    private readonly timer: Timer,
    cgb: boolean = false,
    preBoot: boolean = false
  ) {
    this.regs = new Registers(cgb, preBoot);
  }

  /** Optional APU reference. When set, ticked per bus-access at real-time
   *  T-cycle granularity (2 T per CPU M-cycle in double-speed, 4 otherwise)
   *  so wave-channel RAM reads observe the position that was being played
   *  at the bus-cycle of the read — Blargg `cgb_sound 09` requires this. */
  apu: APU | null = null;

  // ─── Bus access with per-cycle timer ticking ──────────────────────────────

  /** Advance the timer by 1 M-cycle before each memory bus access, so reads
   *  and writes observe the timer state at the end of their own bus cycle.
   *
   *  APU ticks are split around the access: the LR35902 lands the read /
   *  write at T=3 of its 4-T M-cycle, so the APU's sub-units (notably
   *  the wave channel's 2-MHz prescaler) have advanced three T-cycles
   *  when the bus call fires and one more on the way out. This
   *  sub-M-cycle split is what lets Blargg `cgb_sound 09` resolve its
   *  2-T-per-iteration phase sweep — in combination with the
   *  prescaler model in `WaveChannel`. In double-speed mode each
   *  M-cycle is two real T-cycles, so we split 1 + 1 (close enough to
   *  the exact 1.5 + 0.5; double-speed isn't what the sound tests
   *  exercise). */
  private busRead(addr: number): number {
    this.mmu.tickDma(1);
    const apu = this.apu;
    if (apu) apu.tickTCycles(this.doubleSpeed ? 1 : 3);
    this.ticksThisInstr++;
    const v = this.mmu.readByte(addr);
    this.timer.tick(1);
    if (apu) apu.tickTCycles(1);
    return v;
  }

  private busWrite(addr: number, value: number): void {
    this.mmu.tickDma(1);
    const apu = this.apu;
    if (apu) apu.tickTCycles(this.doubleSpeed ? 1 : 3);
    this.ticksThisInstr++;
    this.mmu.writeByte(addr, value);
    this.timer.tick(1);
    if (apu) apu.tickTCycles(1);
  }

  private internalCycle(): void {
    this.mmu.tickDma(1);
    this.timer.tick(1);
    if (this.apu) this.apu.tickTCycles(this.doubleSpeed ? 2 : 4);
    this.ticksThisInstr++;
  }

  private finishTicks(total: number): void {
    const remainder = total - this.ticksThisInstr;
    if (remainder > 0) {
      this.mmu.tickDma(remainder);
      this.timer.tick(remainder);
      if (this.apu) this.apu.tickTCycles(remainder * (this.doubleSpeed ? 2 : 4));
    }
  }

  // ─── CGB KEY1 (0xFF4D) ────────────────────────────────────────────────────

  readKey1(): number {
    return 0x7e | (this.doubleSpeed ? 0x80 : 0) | (this.key1Armed ? 0x01 : 0);
  }

  writeKey1(v: number): void {
    this.key1Armed = (v & 0x01) !== 0;
  }

  // ─── Save state ───────────────────────────────────────────────────────────

  serialize(w: StateWriter): void {
    this.regs.serialize(w);
    w.bool(this.ime);
    w.bool(this.imeScheduled);
    w.bool(this.halted);
    w.bool(this.stopped);
    w.bool(this.doubleSpeed);
    w.bool(this.key1Armed);
    w.bool(this.haltBug);
  }
  deserialize(r: StateReader): void {
    this.regs.deserialize(r);
    this.ime = r.bool();
    this.imeScheduled = r.bool();
    this.halted = r.bool();
    this.stopped = r.bool();
    this.doubleSpeed = r.bool();
    this.key1Armed = r.bool();
    this.haltBug = r.bool();
  }

  // ─── Main step ────────────────────────────────────────────────────────────

  /** Execute one instruction (or handle an interrupt). Returns M-cycles used. */
  step(): number {
    this.ticksThisInstr = 0;

    // Inlined pending-interrupt check: on the common path (no IRQ pending)
    // this is two field reads and a bitwise AND rather than a method call.
    // Uses the IME value *entering* this step — the EI-delay promotion below
    // happens after this check, so a pending IRQ right after EI isn't
    // serviced until one full instruction has elapsed.
    const pendingMask = this.interrupts.ie & this.interrupts.if & 0x1f;
    if (pendingMask !== 0) {
      if (this.ime) {
        const c = this.serviceInterrupt(pendingMask & -pendingMask);
        this.finishTicks(c);
        return c;
      }
      if (this.halted) this.halted = false;
    }

    // EI is documented as "interrupts are enabled after the instruction
    // following EI". `imeScheduled` is set by EI's handler; here (one step
    // later) we promote it to `ime` so the NEXT step's interrupt check sees
    // IME=1 — i.e. interrupts are serviceable after the post-EI instruction
    // has finished.
    if (this.imeScheduled) {
      this.imeScheduled = false;
      this.ime = true;
    }

    if (this.halted || this.stopped) {
      this.finishTicks(1);
      return 1;
    }

    // PC breakpoint: latches a hit without executing. Returning 0 tells
    // runFrame to exit its loop so the scheduler sees the hit on the
    // next drain. The armed-PC logic in the registry ensures pressing
    // Step once lets the user advance past the instruction.
    if (checkPc(this.regs.pc)) return 0;

    const cycles = this.execute();
    this.finishTicks(cycles);
    return cycles;
  }

  // ─── Interrupt service ────────────────────────────────────────────────────

  private serviceInterrupt(_flag: number): number {
    this.ime = false;
    this.halted = false;
    // Dispatch is 5 M-cycles: 2 NOPs + 2 push cycles + 1 vector-fetch
    // cycle. Tick each explicitly so interrupt_time and mooneye
    // intr_timing-style tests see the correct per-cycle timer state.
    this.internalCycle(); // M1 internal
    this.internalCycle(); // M2 internal
    const returnAddr = this.regs.pc;
    // The IRQ vector is latched *between* the two pushes. With SP=0, PCH
    // writes to 0xFFFF (= IE) and can change which bit is pending — or
    // zero pending entirely, dispatching to 0x0000 with no acknowledge.
    // With SP=1, PCL is the one that hits 0xFFFF, but that's after the
    // latch so it only affects the next IRQ. Mooneye `ie_push` proves
    // both halves of this distinction.
    this.regs.sp = (this.regs.sp - 1) & 0xffff;
    this.busWrite(this.regs.sp, (returnAddr >> 8) & 0xff); // M3 PCH push
    const pending = this.interrupts.ie & this.interrupts.if & 0x1f;
    const flag = pending & -pending;
    const vector = flag !== 0 ? INTERRUPT_VECTORS[flag]! : 0x0000;
    if (flag !== 0) this.interrupts.acknowledge(flag);
    this.regs.sp = (this.regs.sp - 1) & 0xffff;
    this.busWrite(this.regs.sp, returnAddr & 0xff); // M4 PCL push
    notePush({ callSite: vector, returnAddr, kind: "irq" });
    this.internalCycle(); // M5 internal (PC ← vector)
    this.regs.pc = vector;
    return 5;
  }

  // ─── Fetch ────────────────────────────────────────────────────────────────

  private fetchByte(): number {
    if (this.haltBug) {
      this.haltBug = false;
      return this.busRead(this.regs.pc);
    }
    return this.busRead(this.regs.pc++);
  }

  private fetchWord(): number {
    const lo = this.fetchByte();
    return lo | (this.fetchByte() << 8);
  }

  // ─── Stack ────────────────────────────────────────────────────────────────

  private stackPush(value: number): void {
    // Real hardware pushes the HIGH byte first, then the low byte
    // (M=2 hi-write, M=3 lo-write). This shows up in Mooneye `push_timing`
    // / `rst_timing` / `call_*_timing2`, all of which probe whether the
    // bus access at M=2 hits the right address with the right data.
    this.regs.sp = (this.regs.sp - 2) & 0xffff;
    this.busWrite((this.regs.sp + 1) & 0xffff, (value >> 8) & 0xff);
    this.busWrite(this.regs.sp, value & 0xff);
  }

  private stackPop(): number {
    const lo = this.busRead(this.regs.sp);
    const hi = this.busRead((this.regs.sp + 1) & 0xffff);
    this.regs.sp = (this.regs.sp + 2) & 0xffff;
    return lo | (hi << 8);
  }

  // ─── r8 register encoding (bits 2-0 of opcode) ───────────────────────────
  // 0=B  1=C  2=D  3=E  4=H  5=L  6=(HL)  7=A

  private getR8(code: number): number {
    switch (code & 7) {
      case 0:
        return this.regs.b;
      case 1:
        return this.regs.c;
      case 2:
        return this.regs.d;
      case 3:
        return this.regs.e;
      case 4:
        return this.regs.h;
      case 5:
        return this.regs.l;
      case 6:
        return this.busRead(this.regs.hl);
      case 7:
        return this.regs.a;
      default:
        return 0;
    }
  }

  private setR8(code: number, v: number): void {
    switch (code & 7) {
      case 0:
        this.regs.b = v;
        return;
      case 1:
        this.regs.c = v;
        return;
      case 2:
        this.regs.d = v;
        return;
      case 3:
        this.regs.e = v;
        return;
      case 4:
        this.regs.h = v;
        return;
      case 5:
        this.regs.l = v;
        return;
      case 6:
        this.busWrite(this.regs.hl, v);
        return;
      case 7:
        this.regs.a = v;
        return;
    }
  }

  // ─── ALU ──────────────────────────────────────────────────────────────────

  private addA(n: number): void {
    const a = this.regs.a,
      r = a + n;
    this.regs.a = r & 0xff;
    this.regs.zf = (r & 0xff) === 0;
    this.regs.nf = false;
    this.regs.hf = (a & 0xf) + (n & 0xf) > 0xf;
    this.regs.cf = r > 0xff;
  }

  private adcA(n: number): void {
    const a = this.regs.a,
      c = this.regs.cf ? 1 : 0,
      r = a + n + c;
    this.regs.a = r & 0xff;
    this.regs.zf = (r & 0xff) === 0;
    this.regs.nf = false;
    this.regs.hf = (a & 0xf) + (n & 0xf) + c > 0xf;
    this.regs.cf = r > 0xff;
  }

  private subA(n: number): void {
    const a = this.regs.a,
      r = a - n;
    this.regs.a = r & 0xff;
    this.regs.zf = (r & 0xff) === 0;
    this.regs.nf = true;
    this.regs.hf = (a & 0xf) < (n & 0xf);
    this.regs.cf = r < 0;
  }

  private sbcA(n: number): void {
    const a = this.regs.a,
      c = this.regs.cf ? 1 : 0,
      r = a - n - c;
    this.regs.a = r & 0xff;
    this.regs.zf = (r & 0xff) === 0;
    this.regs.nf = true;
    this.regs.hf = (a & 0xf) - (n & 0xf) - c < 0;
    this.regs.cf = r < 0;
  }

  private andA(n: number): void {
    this.regs.a = this.regs.a & n;
    this.regs.zf = this.regs.a === 0;
    this.regs.nf = false;
    this.regs.hf = true;
    this.regs.cf = false;
  }

  private xorA(n: number): void {
    this.regs.a = this.regs.a ^ n;
    this.regs.zf = this.regs.a === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = false;
  }

  private orA(n: number): void {
    this.regs.a = this.regs.a | n;
    this.regs.zf = this.regs.a === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = false;
  }

  private cpA(n: number): void {
    const a = this.regs.a,
      r = a - n;
    this.regs.zf = (r & 0xff) === 0;
    this.regs.nf = true;
    this.regs.hf = (a & 0xf) < (n & 0xf);
    this.regs.cf = r < 0;
  }

  /** INC r8 — does not affect CF. Returns M-cycles (3 for (HL), 1 for reg). */
  private incR8(code: number): number {
    const v = this.getR8(code),
      r = (v + 1) & 0xff;
    this.setR8(code, r);
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = (v & 0xf) === 0xf;
    return code === 6 ? 3 : 1;
  }

  /** DEC r8 — does not affect CF. Returns M-cycles (3 for (HL), 1 for reg). */
  private decR8(code: number): number {
    const v = this.getR8(code),
      r = (v - 1) & 0xff;
    this.setR8(code, r);
    this.regs.zf = r === 0;
    this.regs.nf = true;
    this.regs.hf = (v & 0xf) === 0;
    return code === 6 ? 3 : 1;
  }

  /** ADD HL, r16 — does not affect ZF. */
  private addHL(n: number): void {
    const hl = this.regs.hl,
      r = hl + n;
    this.regs.hl = r & 0xffff;
    this.regs.nf = false;
    this.regs.hf = (hl & 0xfff) + (n & 0xfff) > 0xfff;
    this.regs.cf = r > 0xffff;
  }

  /** DAA — decimal-adjust A after BCD arithmetic. */
  private daa(): void {
    let a = this.regs.a;
    if (!this.regs.nf) {
      if (this.regs.hf || (a & 0xf) > 9) a += 0x06;
      if (this.regs.cf || a > 0x9f) {
        a += 0x60;
        this.regs.cf = true;
      }
    } else {
      if (this.regs.hf) a -= 0x06;
      if (this.regs.cf) a -= 0x60;
    }
    this.regs.a = a & 0xff;
    this.regs.zf = this.regs.a === 0;
    this.regs.hf = false;
  }

  // ─── Rotate / shift (CB-prefix versions set Z; accumulator versions reset Z) ─

  private rlc(v: number): number {
    const r = ((v << 1) | (v >> 7)) & 0xff;
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = (v & 0x80) !== 0;
    return r;
  }

  private rrc(v: number): number {
    const r = ((v >> 1) | ((v & 1) << 7)) & 0xff;
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = (v & 0x01) !== 0;
    return r;
  }

  private rl(v: number): number {
    const cin = this.regs.cf ? 1 : 0;
    const r = ((v << 1) | cin) & 0xff;
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = (v & 0x80) !== 0;
    return r;
  }

  private rr(v: number): number {
    const cin = this.regs.cf ? 0x80 : 0;
    const r = ((v >> 1) | cin) & 0xff;
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = (v & 0x01) !== 0;
    return r;
  }

  private sla(v: number): number {
    const r = (v << 1) & 0xff;
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = (v & 0x80) !== 0;
    return r;
  }

  private sra(v: number): number {
    const r = ((v >> 1) | (v & 0x80)) & 0xff;
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = (v & 0x01) !== 0;
    return r;
  }

  private swap(v: number): number {
    const r = ((v & 0x0f) << 4) | (v >> 4);
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = false;
    return r;
  }

  private srl(v: number): number {
    const r = (v >> 1) & 0xff;
    this.regs.zf = r === 0;
    this.regs.nf = false;
    this.regs.hf = false;
    this.regs.cf = (v & 0x01) !== 0;
    return r;
  }

  // ─── Jump helpers ─────────────────────────────────────────────────────────

  /** JR e: 3 M-cycles if taken (fetch + fetch e + internal jump), 2 if not. */
  private jr(cond: boolean): number {
    const offset = (this.fetchByte() << 24) >> 24; // sign-extend
    if (cond) {
      this.internalCycle();
      this.regs.pc = (this.regs.pc + offset) & 0xffff;
      return 3;
    }
    return 2;
  }

  /** JP nn: 4 M-cycles if taken (fetch + fetch lo + fetch hi + internal
   *  jump), 3 if not. */
  private jp(cond: boolean): number {
    const addr = this.fetchWord();
    if (cond) {
      this.internalCycle();
      this.regs.pc = addr;
      return 4;
    }
    return 3;
  }

  /** CALL nn: 6 M-cycles if taken (fetch + fetch lo + fetch hi + internal
   *  + push hi + push lo), 3 if not. */
  private call(cond: boolean): number {
    const addr = this.fetchWord();
    if (cond) {
      this.internalCycle();
      this.stackPush(this.regs.pc);
      notePush({ callSite: this.opPc, returnAddr: this.regs.pc, kind: "call" });
      this.regs.pc = addr;
      return 6;
    }
    return 3;
  }

  /** RET cc: 5 M-cycles if taken (fetch + internal cc-check + pop lo +
   *  pop hi + internal jump), 2 if not (fetch + internal cc-check). */
  private retCc(cond: boolean): number {
    this.internalCycle();
    if (cond) {
      this.regs.pc = this.stackPop();
      notePop();
      this.internalCycle();
      return 5;
    }
    return 2;
  }

  /** RET unconditional / RETI: 4 M-cycles (fetch + pop lo + pop hi +
   *  internal jump). */
  private retUncond(): number {
    this.regs.pc = this.stackPop();
    notePop();
    this.internalCycle();
    return 4;
  }

  /** RST n: internal cycle, push PC, jump to `vec` (0x00 / 0x08 / … 0x38).
   *  Shared by the eight RST opcodes (0xC7 / 0xCF / … / 0xFF). 4 M-cycles. */
  private rst(vec: number): number {
    this.internalCycle();
    this.stackPush(this.regs.pc);
    notePush({ callSite: this.opPc, returnAddr: this.regs.pc, kind: "rst" });
    this.regs.pc = vec;
    return 4;
  }

  // ─── ADD SP, r8 / LD HL, SP+r8 flag helper ───────────────────────────────
  // Flags use the raw unsigned offset byte. Z=0, N=0.

  private spAddFlags(sp: number, r8: number): void {
    this.regs.zf = false;
    this.regs.nf = false;
    this.regs.hf = (sp & 0xf) + (r8 & 0xf) > 0xf;
    this.regs.cf = (sp & 0xff) + r8 > 0xff;
  }

  // ─── Main instruction dispatch ────────────────────────────────────────────

  private execute(): number {
    this.opPc = this.regs.pc;
    const op = this.fetchByte();

    // ── Block: LD r, r  (0x40–0x7F) ─────────────────────────────────────────
    // 0x76 is HALT, not LD (HL),(HL).
    if (op >= 0x40 && op <= 0x7f) {
      if (op === 0x76) {
        // HALT bug: if IME=0 and an interrupt is already pending, the CPU
        // skips halting and instead fails to increment PC on the *next*
        // fetch. Otherwise enter the normal halted state.
        const pending = this.interrupts.ie & this.interrupts.if & 0x1f;
        if (!this.ime && pending !== 0) this.haltBug = true;
        else this.halted = true;
        return 1;
      }
      const dst = (op >> 3) & 7;
      const src = op & 7;
      this.setR8(dst, this.getR8(src));
      return src === 6 || dst === 6 ? 2 : 1;
    }

    // ── Block: ALU A, r  (0x80–0xBF) ─────────────────────────────────────────
    if (op >= 0x80 && op <= 0xbf) {
      const fn = (op >> 3) & 7;
      const src = op & 7;
      const v = this.getR8(src);
      switch (fn) {
        case 0:
          this.addA(v);
          break;
        case 1:
          this.adcA(v);
          break;
        case 2:
          this.subA(v);
          break;
        case 3:
          this.sbcA(v);
          break;
        case 4:
          this.andA(v);
          break;
        case 5:
          this.xorA(v);
          break;
        case 6:
          this.orA(v);
          break;
        case 7:
          this.cpA(v);
          break;
      }
      return src === 6 ? 2 : 1;
    }

    // ── All remaining opcodes ─────────────────────────────────────────────────
    switch (op) {
      // ───────────── 0x0_ ──────────────────────────────────────────────────
      case 0x00:
        return 1; // NOP
      case 0x01:
        this.regs.bc = this.fetchWord();
        return 3; // LD BC, d16
      case 0x02:
        this.busWrite(this.regs.bc, this.regs.a);
        return 2; // LD (BC), A
      case 0x03:
        this.regs.bc = (this.regs.bc + 1) & 0xffff;
        this.internalCycle();
        return 2; // INC BC
      case 0x04:
        return this.incR8(0); // INC B
      case 0x05:
        return this.decR8(0); // DEC B
      case 0x06:
        this.regs.b = this.fetchByte();
        return 2; // LD B, d8
      case 0x07: {
        // RLCA
        const c = (this.regs.a & 0x80) !== 0;
        this.regs.a = ((this.regs.a << 1) | (c ? 1 : 0)) & 0xff;
        this.regs.zf = false;
        this.regs.nf = false;
        this.regs.hf = false;
        this.regs.cf = c;
        return 1;
      }
      case 0x08: {
        // LD (a16), SP
        const addr = this.fetchWord();
        this.busWrite(addr, this.regs.sp & 0xff);
        this.busWrite((addr + 1) & 0xffff, (this.regs.sp >> 8) & 0xff);
        return 5;
      }
      case 0x09:
        this.addHL(this.regs.bc);
        this.internalCycle();
        return 2; // ADD HL, BC
      case 0x0a:
        this.regs.a = this.busRead(this.regs.bc);
        return 2; // LD A, (BC)
      case 0x0b:
        this.regs.bc = (this.regs.bc - 1) & 0xffff;
        this.internalCycle();
        return 2; // DEC BC
      case 0x0c:
        return this.incR8(1); // INC C
      case 0x0d:
        return this.decR8(1); // DEC C
      case 0x0e:
        this.regs.c = this.fetchByte();
        return 2; // LD C, d8
      case 0x0f: {
        // RRCA
        const c = (this.regs.a & 0x01) !== 0;
        this.regs.a = ((this.regs.a >> 1) | (c ? 0x80 : 0)) & 0xff;
        this.regs.zf = false;
        this.regs.nf = false;
        this.regs.hf = false;
        this.regs.cf = c;
        return 1;
      }

      // ───────────── 0x1_ ──────────────────────────────────────────────────
      case 0x10: {
        // STOP
        this.fetchByte();
        // In CGB mode STOP with KEY1.0 armed performs a speed switch
        // instead of halting. Real hardware also resets DIV to 0 — that
        // edge is what same-suite's `div_*_10` tests probe (a STOP-driven
        // speed switch must drop DIV bit 12/13 to fall, stepping the
        // APU's frame sequencer).
        if (this.key1Armed) {
          this.doubleSpeed = !this.doubleSpeed;
          this.key1Armed = false;
          this.timer.writeByte(0xff04, 0);
        } else {
          this.stopped = true;
        }
        return 1;
      }
      case 0x11:
        this.regs.de = this.fetchWord();
        return 3; // LD DE, d16
      case 0x12:
        this.busWrite(this.regs.de, this.regs.a);
        return 2; // LD (DE), A
      case 0x13:
        this.regs.de = (this.regs.de + 1) & 0xffff;
        this.internalCycle();
        return 2; // INC DE
      case 0x14:
        return this.incR8(2); // INC D
      case 0x15:
        return this.decR8(2); // DEC D
      case 0x16:
        this.regs.d = this.fetchByte();
        return 2; // LD D, d8
      case 0x17: {
        // RLA
        const cin = this.regs.cf ? 1 : 0;
        const c = (this.regs.a & 0x80) !== 0;
        this.regs.a = ((this.regs.a << 1) | cin) & 0xff;
        this.regs.zf = false;
        this.regs.nf = false;
        this.regs.hf = false;
        this.regs.cf = c;
        return 1;
      }
      case 0x18:
        return this.jr(true); // JR r8
      case 0x19:
        this.addHL(this.regs.de);
        this.internalCycle();
        return 2; // ADD HL, DE
      case 0x1a:
        this.regs.a = this.busRead(this.regs.de);
        return 2; // LD A, (DE)
      case 0x1b:
        this.regs.de = (this.regs.de - 1) & 0xffff;
        this.internalCycle();
        return 2; // DEC DE
      case 0x1c:
        return this.incR8(3); // INC E
      case 0x1d:
        return this.decR8(3); // DEC E
      case 0x1e:
        this.regs.e = this.fetchByte();
        return 2; // LD E, d8
      case 0x1f: {
        // RRA
        const cin = this.regs.cf ? 0x80 : 0;
        const c = (this.regs.a & 0x01) !== 0;
        this.regs.a = ((this.regs.a >> 1) | cin) & 0xff;
        this.regs.zf = false;
        this.regs.nf = false;
        this.regs.hf = false;
        this.regs.cf = c;
        return 1;
      }

      // ───────────── 0x2_ ──────────────────────────────────────────────────
      case 0x20:
        return this.jr(!this.regs.zf); // JR NZ, r8
      case 0x21:
        this.regs.hl = this.fetchWord();
        return 3; // LD HL, d16
      case 0x22: // LD (HL+), A
        this.busWrite(this.regs.hl, this.regs.a);
        this.regs.hl = (this.regs.hl + 1) & 0xffff;
        return 2;
      case 0x23:
        this.regs.hl = (this.regs.hl + 1) & 0xffff;
        this.internalCycle();
        return 2; // INC HL
      case 0x24:
        return this.incR8(4); // INC H
      case 0x25:
        return this.decR8(4); // DEC H
      case 0x26:
        this.regs.h = this.fetchByte();
        return 2; // LD H, d8
      case 0x27:
        this.daa();
        return 1; // DAA
      case 0x28:
        return this.jr(this.regs.zf); // JR Z, r8
      case 0x29:
        this.addHL(this.regs.hl);
        this.internalCycle();
        return 2; // ADD HL, HL
      case 0x2a: // LD A, (HL+)
        this.regs.a = this.busRead(this.regs.hl);
        this.regs.hl = (this.regs.hl + 1) & 0xffff;
        return 2;
      case 0x2b:
        this.regs.hl = (this.regs.hl - 1) & 0xffff;
        this.internalCycle();
        return 2; // DEC HL
      case 0x2c:
        return this.incR8(5); // INC L
      case 0x2d:
        return this.decR8(5); // DEC L
      case 0x2e:
        this.regs.l = this.fetchByte();
        return 2; // LD L, d8
      case 0x2f: // CPL
        this.regs.a = ~this.regs.a & 0xff;
        this.regs.nf = true;
        this.regs.hf = true;
        return 1;

      // ───────────── 0x3_ ──────────────────────────────────────────────────
      case 0x30:
        return this.jr(!this.regs.cf); // JR NC, r8
      case 0x31:
        this.regs.sp = this.fetchWord();
        return 3; // LD SP, d16
      case 0x32: // LD (HL-), A
        this.busWrite(this.regs.hl, this.regs.a);
        this.regs.hl = (this.regs.hl - 1) & 0xffff;
        return 2;
      case 0x33:
        this.regs.sp = (this.regs.sp + 1) & 0xffff;
        this.internalCycle();
        return 2; // INC SP
      case 0x34:
        return this.incR8(6); // INC (HL)
      case 0x35:
        return this.decR8(6); // DEC (HL)
      case 0x36:
        this.busWrite(this.regs.hl, this.fetchByte());
        return 3; // LD (HL), d8
      case 0x37: // SCF
        this.regs.nf = false;
        this.regs.hf = false;
        this.regs.cf = true;
        return 1;
      case 0x38:
        return this.jr(this.regs.cf); // JR C, r8
      case 0x39:
        this.addHL(this.regs.sp);
        this.internalCycle();
        return 2; // ADD HL, SP
      case 0x3a: // LD A, (HL-)
        this.regs.a = this.busRead(this.regs.hl);
        this.regs.hl = (this.regs.hl - 1) & 0xffff;
        return 2;
      case 0x3b:
        this.regs.sp = (this.regs.sp - 1) & 0xffff;
        this.internalCycle();
        return 2; // DEC SP
      case 0x3c:
        return this.incR8(7); // INC A
      case 0x3d:
        return this.decR8(7); // DEC A
      case 0x3e:
        this.regs.a = this.fetchByte();
        return 2; // LD A, d8
      case 0x3f: // CCF
        this.regs.nf = false;
        this.regs.hf = false;
        this.regs.cf = !this.regs.cf;
        return 1;

      // ───────────── 0xC_ ──────────────────────────────────────────────────
      case 0xc0:
        return this.retCc(!this.regs.zf); // RET NZ
      case 0xc1:
        this.regs.bc = this.stackPop();
        return 3; // POP BC
      case 0xc2:
        return this.jp(!this.regs.zf); // JP NZ, a16
      case 0xc3:
        return this.jp(true); // JP a16
      case 0xc4:
        return this.call(!this.regs.zf); // CALL NZ, a16
      case 0xc5:
        this.internalCycle();
        this.stackPush(this.regs.bc);
        return 4; // PUSH BC
      case 0xc6:
        this.addA(this.fetchByte());
        return 2; // ADD A, d8
      case 0xc7:
        return this.rst(0x00); // RST 00H
      case 0xc8:
        return this.retCc(this.regs.zf); // RET Z
      case 0xc9:
        return this.retUncond(); // RET
      case 0xca:
        return this.jp(this.regs.zf); // JP Z, a16
      case 0xcb:
        return this.executeCB(); // CB prefix
      case 0xcc:
        return this.call(this.regs.zf); // CALL Z, a16
      case 0xcd:
        return this.call(true); // CALL a16
      case 0xce:
        this.adcA(this.fetchByte());
        return 2; // ADC A, d8
      case 0xcf:
        return this.rst(0x08); // RST 08H

      // ───────────── 0xD_ ──────────────────────────────────────────────────
      case 0xd0:
        return this.retCc(!this.regs.cf); // RET NC
      case 0xd1:
        this.regs.de = this.stackPop();
        return 3; // POP DE
      case 0xd2:
        return this.jp(!this.regs.cf); // JP NC, a16
      case 0xd4:
        return this.call(!this.regs.cf); // CALL NC, a16
      case 0xd5:
        this.internalCycle();
        this.stackPush(this.regs.de);
        return 4; // PUSH DE
      case 0xd6:
        this.subA(this.fetchByte());
        return 2; // SUB d8
      case 0xd7:
        return this.rst(0x10); // RST 10H
      case 0xd8:
        return this.retCc(this.regs.cf); // RET C
      case 0xd9: {
        const c = this.retUncond();
        this.ime = true;
        return c;
      } // RETI
      case 0xda:
        return this.jp(this.regs.cf); // JP C, a16
      case 0xdc:
        return this.call(this.regs.cf); // CALL C, a16
      case 0xde:
        this.sbcA(this.fetchByte());
        return 2; // SBC A, d8
      case 0xdf:
        return this.rst(0x18); // RST 18H

      // ───────────── 0xE_ ──────────────────────────────────────────────────
      case 0xe0:
        this.busWrite(0xff00 | this.fetchByte(), this.regs.a);
        return 3; // LDH (a8), A
      case 0xe1:
        this.regs.hl = this.stackPop();
        return 3; // POP HL
      case 0xe2:
        this.busWrite(0xff00 | this.regs.c, this.regs.a);
        return 2; // LD (C), A
      case 0xe5:
        this.internalCycle();
        this.stackPush(this.regs.hl);
        return 4; // PUSH HL
      case 0xe6:
        this.andA(this.fetchByte());
        return 2; // AND d8
      case 0xe7:
        return this.rst(0x20); // RST 20H
      case 0xe8: {
        // ADD SP, r8
        const r8 = this.fetchByte();
        const sp = this.regs.sp;
        this.spAddFlags(sp, r8);
        this.internalCycle(); // M3 internal
        this.internalCycle(); // M4 internal
        this.regs.sp = (sp + ((r8 << 24) >> 24)) & 0xffff;
        return 4;
      }
      case 0xe9:
        this.regs.pc = this.regs.hl;
        return 1; // JP HL
      case 0xea:
        this.busWrite(this.fetchWord(), this.regs.a);
        return 4; // LD (a16), A
      case 0xee:
        this.xorA(this.fetchByte());
        return 2; // XOR d8
      case 0xef:
        return this.rst(0x28); // RST 28H

      // ───────────── 0xF_ ──────────────────────────────────────────────────
      case 0xf0:
        this.regs.a = this.busRead(0xff00 | this.fetchByte());
        return 3; // LDH A, (a8)
      case 0xf1:
        this.regs.af = this.stackPop();
        return 3; // POP AF
      case 0xf2:
        this.regs.a = this.busRead(0xff00 | this.regs.c);
        return 2; // LD A, (C)
      case 0xf3:
        this.ime = false;
        return 1; // DI
      case 0xf5:
        this.internalCycle();
        this.stackPush(this.regs.af);
        return 4; // PUSH AF
      case 0xf6:
        this.orA(this.fetchByte());
        return 2; // OR d8
      case 0xf7:
        return this.rst(0x30); // RST 30H
      case 0xf8: {
        // LD HL, SP+r8
        const r8 = this.fetchByte();
        const sp = this.regs.sp;
        this.spAddFlags(sp, r8);
        this.internalCycle(); // M3 internal
        this.regs.hl = (sp + ((r8 << 24) >> 24)) & 0xffff;
        return 3;
      }
      case 0xf9:
        this.internalCycle();
        this.regs.sp = this.regs.hl;
        return 2; // LD SP, HL
      case 0xfa:
        this.regs.a = this.busRead(this.fetchWord());
        return 4; // LD A, (a16)
      case 0xfb:
        this.imeScheduled = true;
        return 1; // EI
      case 0xfe:
        this.cpA(this.fetchByte());
        return 2; // CP d8
      case 0xff:
        return this.rst(0x38); // RST 38H

      default:
        throw new Error(
          `Illegal opcode 0x${op.toString(16).padStart(2, "0")} ` +
            `at PC=0x${(this.regs.pc - 1).toString(16).padStart(4, "0")}`
        );
    }
  }

  // ─── CB-prefix table ──────────────────────────────────────────────────────
  //
  // Layout: upper 2 bits = operation class, bits 5-3 = bit index, bits 2-0 = r8
  //   0x00–0x3F  Rotate/shift  (fn = bits 5-3)
  //   0x40–0x7F  BIT b, r
  //   0x80–0xBF  RES b, r
  //   0xC0–0xFF  SET b, r
  //
  // Timing: 2 M-cycles for register ops, 4 for (HL) (3 for BIT (HL)).

  private executeCB(): number {
    const op = this.fetchByte();
    const reg = op & 7;
    const bit = (op >> 3) & 7;
    const isHL = reg === 6;

    if (op >= 0xc0) {
      // SET b, r
      this.setR8(reg, this.getR8(reg) | (1 << bit));
      return isHL ? 4 : 2;
    }

    if (op >= 0x80) {
      // RES b, r
      this.setR8(reg, this.getR8(reg) & ~(1 << bit));
      return isHL ? 4 : 2;
    }

    if (op >= 0x40) {
      // BIT b, r
      this.regs.zf = (this.getR8(reg) & (1 << bit)) === 0;
      this.regs.nf = false;
      this.regs.hf = true;
      return isHL ? 3 : 2;
    }

    // Rotate / shift group (0x00–0x3F)
    const v = this.getR8(reg);
    let r: number;
    switch (
      bit // bit field doubles as fn selector here
    ) {
      case 0:
        r = this.rlc(v);
        break; // RLC
      case 1:
        r = this.rrc(v);
        break; // RRC
      case 2:
        r = this.rl(v);
        break; // RL
      case 3:
        r = this.rr(v);
        break; // RR
      case 4:
        r = this.sla(v);
        break; // SLA
      case 5:
        r = this.sra(v);
        break; // SRA
      case 6:
        r = this.swap(v);
        break; // SWAP
      case 7:
        r = this.srl(v);
        break; // SRL
      default:
        r = v;
    }
    this.setR8(reg, r);
    return isHL ? 4 : 2;
  }
}
