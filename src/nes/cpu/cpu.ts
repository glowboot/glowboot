/**
 * MOS 6502 / Ricoh 2A03 CPU core.
 *
 * The 2A03 is a 6502 with decimal mode disabled (the `D` flag still toggles but
 * has no effect on ADC/SBC). Cycle-accurate at instruction granularity: every
 * memory access goes through {@link Bus}, and `step()` returns the exact cycle
 * count — including page-cross and branch penalties — so the PPU/APU can be
 * ticked 3 dots per CPU cycle (3.2 on PAL) by the bus implementation.
 *
 * Validated instruction-by-instruction against the `nestest.nes` golden CPU
 * log: PC, A, X, Y, P, SP, and cumulative cycle count all match.
 *
 * Reference: https://www.nesdev.org/wiki/CPU and the 6502 opcode matrix.
 */

import { checkPc, checkRead, checkWrite } from "../debug/breakpoints.js";
import { notePop, notePush } from "../debug/call-stack.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";

export interface Bus {
  /** Read one byte. May have side effects (PPU/APU registers, mapper). */
  read(addr: number): number;
  /** Write one byte. */
  write(addr: number, value: number): void;
}

// Status flag bit positions (P register).
const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_D = 0x08;
const FLAG_B = 0x10;
const FLAG_U = 0x20; // unused — always reads as 1
const FLAG_V = 0x40;
const FLAG_N = 0x80;

// The "magic constant" the unstable ANE/LXA opcodes OR into A. The real value
// is analog and varies by console/temperature; 0xFF is the value blargg's
// instr_test was scored against and what most emulators use.
const UNSTABLE_MAGIC = 0xff;

/** Which CPU-cycle parity is a DMA "put" cycle. The absolute anchor of the
 *  APU get/put phase against our cycle counter is fixed at reset; this value
 *  is validated by the blargg DMC-DMA suite. */
const DMA_PUT_PARITY = 0;

const STACK_BASE = 0x0100;
const NMI_VECTOR = 0xfffa;
const RESET_VECTOR = 0xfffc;
const IRQ_VECTOR = 0xfffe;

/** Base cycle count per opcode (before page-cross / branch penalties). */
// prettier-ignore
const CYCLES: readonly number[] = [
  7,6,0,8,3,3,5,5,3,2,2,2,4,4,6,6, // 00
  2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7, // 10
  6,6,0,8,3,3,5,5,4,2,2,2,4,4,6,6, // 20
  2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7, // 30
  6,6,0,8,3,3,5,5,3,2,2,2,3,4,6,6, // 40
  2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7, // 50
  6,6,0,8,3,3,5,5,4,2,2,2,5,4,6,6, // 60
  2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7, // 70
  2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4, // 80
  2,6,0,6,4,4,4,4,2,5,2,5,5,5,5,5, // 90
  2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4, // A0
  2,5,0,5,4,4,4,4,2,4,2,4,4,4,4,4, // B0
  2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6, // C0
  2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7, // D0
  2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6, // E0
  2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7, // F0
];

/** Addressing modes. */
const enum Mode {
  IMP, // implied / accumulator
  IMM, // immediate
  ZP,
  ZPX,
  ZPY,
  ABS,
  ABX,
  ABY,
  IND, // JMP (indirect) only
  IZX, // (indirect,X)
  IZY, // (indirect),Y
  REL // branch
}

export class CPU {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xfd;
  pc = 0;
  /** Status flags as a packed byte. Bit 5 (U) is always set. */
  p = FLAG_I | FLAG_U;
  /** Cumulative CPU cycles since reset. */
  cycles = 0;

  /**
   * Called for every CPU cycle as it is consumed, so the rest of the system
   * (PPU at 3 dots/cycle, APU) advances in lockstep and memory-mapped reads see
   * the exact state for that cycle. Null for headless CPU-only runs (nestest).
   */
  onTick: ((cycles: number) => void) | null = null;

  /** A DMC sample DMA is waiting for the CPU to halt. The 2A03 pulls RDY low
   *  but the CPU only stops on a read cycle — and only on the DMA kind's halt
   *  parity (see {@link dmcDmaReload}) — so {@link read} defers the stall
   *  until an eligible cycle. Set by the console when the DMC needs a byte. */
  dmcDmaPending = false;
  /** Whether the pending DMA is a reload (buffer emptied by the output unit).
   *  Reload DMAs halt on a put cycle — halt, dummy, alignment, get — stealing
   *  a constant 4 cycles; $4015 load DMAs halt on a get cycle no earlier than
   *  the 2nd APU cycle after the write — halt, dummy, get — stealing 3. */
  dmcDmaReload = false;
  /** CPU cycle when the pending request was raised (load-DMA halt delay). */
  dmcDmaRequestCycle = 0;
  /** The DMA's get cycle — reads the sample byte into the DMC's buffer. */
  onDmcFetch: (() => void) | null = null;

  /** Penalty cycles (page-cross / branch) accrued by the current instruction. */
  private extra = 0;

  /** Pending interrupt lines (level-sampled). */
  private nmiPending = false;
  private irqLine = false;
  /** The I flag value used for IRQ polling. It lags the architectural I flag by
   *  one instruction (snapshotted before each opcode runs), so CLI / SEI / PLP
   *  take effect on interrupt recognition one instruction late — the real 6502
   *  behaviour. RTI overrides it immediately. */
  private pollI = true;
  /** Interrupt lines as sampled at the second-to-last cycle of the current
   *  instruction — the point the 6502 actually polls. Captured each cycle in
   *  {@link tick} (so the final value is the penultimate-cycle state) and read
   *  once the instruction finishes to decide whether the next step is the
   *  interrupt sequence. */
  private polledNmi = false;
  private polledIrq = false;
  /** Freezes the poll one cycle early for a taken non-page-crossing branch,
   *  which polls "before the second cycle, not before the third". Reset each
   *  instruction; transient, not serialized. */
  private pollLocked = false;
  /** Latched at the poll: the next step runs the interrupt sequence (NMI if
   *  {@link serviceIsNmi}, else IRQ) instead of fetching an opcode. Carries
   *  across the instruction boundary, so both are serialized. */
  private serviceInterrupt = false;
  private serviceIsNmi = false;

  /** Effective address + page-cross flag, set by the active addressing mode. */
  private addr = 0;
  private pageCrossed = false;
  /** Un-fixed indexed address (high byte not carried) — the target of the
   *  dummy read a read instruction performs when an index crosses a page. */
  private dummyAddr = 0;
  /** Address of the opcode currently executing — for the debugger's call-stack
   *  frames (the call site of a JSR / BRK). */
  private opPc = 0;

  constructor(private readonly bus: Bus) {}

  /** Power-on / reset: load PC from the reset vector, prime SP/flags. Takes the
   *  hardware's 7-cycle reset sequence. */
  reset(): void {
    this.pc = this.read16(RESET_VECTOR);
    this.sp = 0xfd;
    this.p = FLAG_I | FLAG_U;
    this.a = this.x = this.y = 0;
    this.cycles = 7;
    this.nmiPending = false;
    this.irqLine = false;
    this.pollI = true;
    this.polledNmi = false;
    this.polledIrq = false;
    this.pollLocked = false;
    this.serviceInterrupt = false;
    this.serviceIsNmi = false;
  }

  /** Soft reset (the RESET button), distinct from power-on: A/X/Y and all RAM
   *  are preserved, the stack pointer is decremented by 3 (the reset sequence's
   *  three suppressed pushes), and the I flag is set. Re-vectors through $FFFC
   *  and takes the hardware's 7 cycles. */
  softReset(): void {
    // Read the vector off the raw bus so the 7-cycle charge below isn't double
    // counted by read()'s per-access ticks.
    this.pc = (this.bus.read(RESET_VECTOR) | (this.bus.read((RESET_VECTOR + 1) & 0xffff) << 8)) & 0xffff;
    this.sp = (this.sp - 3) & 0xff;
    this.setFlag(FLAG_I, true);
    this.tick(7);
    this.nmiPending = false;
    this.pollI = true;
    this.polledNmi = false;
    this.polledIrq = false;
    this.pollLocked = false;
    this.serviceInterrupt = false;
    this.serviceIsNmi = false;
  }

  /** Raise the NMI line (edge-triggered; serviced before the next instruction). */
  nmi(): void {
    this.nmiPending = true;
  }

  /** Set/clear the IRQ line (level-triggered; serviced when I is clear). */
  setIrq(active: boolean): void {
    this.irqLine = active;
  }

  /** Architectural register file + pending interrupt lines. The per-instruction
   *  temporaries (`extra`/`addr`/`pageCrossed`/`dummyAddr`) are recomputed each
   *  step, so they're skipped — save states are taken between instructions. */
  serialize(w: NesStateWriter): void {
    w.u8(this.a);
    w.u8(this.x);
    w.u8(this.y);
    w.u8(this.sp);
    w.u16(this.pc);
    w.u8(this.p);
    w.f64(this.cycles);
    w.bool(this.nmiPending);
    w.bool(this.irqLine);
    w.bool(this.pollI);
    w.bool(this.serviceInterrupt);
    w.bool(this.serviceIsNmi);
    w.bool(this.dmcDmaPending);
    w.bool(this.dmcDmaReload);
    w.f64(this.dmcDmaRequestCycle);
  }
  deserialize(r: NesStateReader): void {
    this.a = r.u8();
    this.x = r.u8();
    this.y = r.u8();
    this.sp = r.u8();
    this.pc = r.u16();
    this.p = r.u8();
    this.cycles = r.f64();
    this.nmiPending = r.bool();
    this.irqLine = r.bool();
    this.pollI = r.bool();
    this.serviceInterrupt = r.bool();
    this.serviceIsNmi = r.bool();
    this.dmcDmaPending = r.bool();
    this.dmcDmaReload = r.bool();
    this.dmcDmaRequestCycle = r.f64();
  }

  /** Advance the clock by `n` CPU cycles, stepping the rest of the system. The
   *  interrupt lines are sampled once per cycle *before* the system advances, so
   *  after the instruction's last cycle `polledNmi/polledIrq` hold the state as
   *  of the second-to-last cycle — the point the 6502 polls. A taken
   *  non-page-crossing branch freezes the sample one cycle early via
   *  `pollLocked`. */
  private tick(n: number): void {
    for (let i = 0; i < n; i++) {
      // The IRQ line is refreshed at the end of each cycle's system step, so
      // sampling it before the advance reads the previous cycle's level — the
      // second-to-last-cycle poll point. The NMI is raised by the PPU mid-step,
      // so it's sampled after the advance. (The two sources land a cycle apart
      // in this engine; this aligns both polls to hardware.)
      if (!this.pollLocked) this.polledIrq = this.irqLine;
      this.cycles += 1;
      this.onTick?.(1);
      if (!this.pollLocked) this.polledNmi = this.nmiPending;
    }
  }

  // ── memory helpers ──────────────────────────────────────────────────────
  // Every 6502 cycle is a bus access, so each read/write advances the clock by
  // one cycle before touching memory — a $2002/$2007 read then observes the PPU
  // at exactly that cycle.
  private read(a: number): number {
    this.tick(1);
    checkRead(a & 0xffff);
    // A reload request raised during this read's own cycle halts this very
    // read (RDY falls mid-cycle and the cycle repeats).
    if (this.dmcDmaPending && this.dmcDmaHaltEligible()) this.dmcDmaStall(a & 0xffff);
    return this.bus.read(a & 0xffff) & 0xff;
  }

  /** Whether this read cycle may host the DMC DMA halt. RDY asserts on the
   *  first PUT cycle at/after a reload request; a $4015 load asserts on a GET
   *  cycle from the 2nd APU cycle after the write. The CPU then halts on its
   *  first read cycle with RDY low — in straight-line read-heavy code that is
   *  the assert cycle itself, which is what makes reload DMAs steal a
   *  constant 4 cycles (the sync loops in blargg's DMA tests depend on it). */
  private dmcDmaHaltEligible(): boolean {
    if (this.dmcDmaReload) {
      const req = this.dmcDmaRequestCycle;
      const assertAt = (req & 1) === DMA_PUT_PARITY ? req : req + 1;
      return this.cycles >= assertAt;
    }
    const req = this.dmcDmaRequestCycle + 2;
    const assertAt = (req & 1) !== DMA_PUT_PARITY ? req : req + 1;
    return this.cycles >= assertAt;
  }

  /** DMC DMA halt, entered on the eligible read cycle. The CPU re-runs this
   *  read on the halt + dummy (+ reload's alignment) cycles — real bus
   *  activity with real side effects (extra $2007 reads). The controller
   *  ports are deliberately exempted from the re-reads: on hardware the DMA
   *  grid's rigid phase arithmetically bounds the DPCM controller glitch to
   *  at most one corrupted read per compensation sequence (what game
   *  double-read loops rely on), and until our halt placement is cycle-exact
   *  enough to reproduce that bound, emulating the bit deletion would corrupt
   *  input WORSE than hardware. The stall timing itself is fully emulated.
   *  The get cycle then fetches the sample byte, and the caller's
   *  fall-through read is the real one whose value the CPU uses. */
  private dmcDmaStall(a: number): void {
    // Halt + dummy, plus an alignment cycle when the get would otherwise land
    // on a put cycle: the DMA read must happen on a get cycle, so a halt on a
    // put-parity cycle (get lands put two later) pays the extra cycle — 4
    // stolen; a get-parity halt pays 3.
    const repeats = (this.cycles & 1) === DMA_PUT_PARITY ? 3 : 2;
    const controller = a === 0x4016 || a === 0x4017;
    for (let i = 0; i < repeats; i++) {
      if (!controller) this.bus.read(a);
      this.tick(1);
    }
    this.onDmcFetch?.(); // the get cycle — the DMA owns the bus
    this.tick(1); // the CPU re-runs its read cycle (the caller completes it)
    // Cleared at exit, not entry: the DMC re-asserts its request every cycle
    // until the fetch lands, and a mid-stall re-assert must not arm a second,
    // phantom stall for the same byte.
    this.dmcDmaPending = false;
  }
  private write(a: number, v: number): void {
    this.tick(1);
    checkWrite(a & 0xffff);
    this.bus.write(a & 0xffff, v & 0xff);
  }
  private read16(a: number): number {
    return this.read(a) | (this.read((a + 1) & 0xffff) << 8);
  }
  /** Read a 16-bit pointer with the 6502 page-wrap bug (high byte wraps within
   *  the same page instead of crossing it). Used by JMP (ind) and (zp,X)/(zp),Y. */
  private read16Bug(a: number): number {
    const lo = this.read(a);
    const hi = this.read((a & 0xff00) | ((a + 1) & 0xff));
    return lo | (hi << 8);
  }
  private fetch(): number {
    const v = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  private fetch16(): number {
    return this.fetch() | (this.fetch() << 8);
  }
  private push(v: number): void {
    this.write(STACK_BASE | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }
  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(STACK_BASE | this.sp);
  }
  private push16(v: number): void {
    this.push((v >> 8) & 0xff);
    this.push(v & 0xff);
  }
  private pull16(): number {
    return this.pull() | (this.pull() << 8);
  }

  // ── flag helpers ────────────────────────────────────────────────────────
  private setZN(v: number): void {
    this.p = (this.p & ~(FLAG_Z | FLAG_N)) | (v === 0 ? FLAG_Z : 0) | (v & FLAG_N);
  }
  private setFlag(mask: number, on: boolean): void {
    if (on) this.p |= mask;
    else this.p &= ~mask;
  }
  private getFlag(mask: number): boolean {
    return (this.p & mask) !== 0;
  }

  // ── addressing ──────────────────────────────────────────────────────────
  /** Resolve the operand address for `mode`, setting `this.addr` and
   *  `this.pageCrossed`. IMP takes no operand, so it resolves to nothing. */
  private resolve(mode: Mode): void {
    this.pageCrossed = false;
    switch (mode) {
      case Mode.IMM:
        this.addr = this.pc;
        this.pc = (this.pc + 1) & 0xffff;
        break;
      case Mode.ZP:
        this.addr = this.fetch();
        break;
      case Mode.ZPX:
        this.addr = (this.fetch() + this.x) & 0xff;
        break;
      case Mode.ZPY:
        this.addr = (this.fetch() + this.y) & 0xff;
        break;
      case Mode.ABS:
        this.addr = this.fetch16();
        break;
      case Mode.ABX: {
        const base = this.fetch16();
        this.addr = (base + this.x) & 0xffff;
        this.dummyAddr = (base & 0xff00) | ((base + this.x) & 0xff);
        this.pageCrossed = (base & 0xff00) !== (this.addr & 0xff00);
        break;
      }
      case Mode.ABY: {
        const base = this.fetch16();
        this.addr = (base + this.y) & 0xffff;
        this.dummyAddr = (base & 0xff00) | ((base + this.y) & 0xff);
        this.pageCrossed = (base & 0xff00) !== (this.addr & 0xff00);
        break;
      }
      case Mode.IND:
        this.addr = this.read16Bug(this.fetch16());
        break;
      case Mode.IZX: {
        const ptr = (this.fetch() + this.x) & 0xff;
        this.addr = this.read16Bug(ptr);
        break;
      }
      case Mode.IZY: {
        const ptr = this.fetch();
        const base = this.read16Bug(ptr);
        this.addr = (base + this.y) & 0xffff;
        this.dummyAddr = (base & 0xff00) | ((base + this.y) & 0xff);
        this.pageCrossed = (base & 0xff00) !== (this.addr & 0xff00);
        break;
      }
      case Mode.REL: {
        const off = this.fetch();
        this.addr = (this.pc + (off < 0x80 ? off : off - 0x100)) & 0xffff;
        break;
      }
      case Mode.IMP:
        break;
    }
  }

  // ── interrupt service ───────────────────────────────────────────────────
  private interrupt(vector: number, brk: boolean): void {
    const returnAddr = this.pc;
    // Two dummy reads at PC open the 7-cycle sequence on real hardware. Doing
    // them here (rather than charging the cycles at the end) puts the NMI sample
    // point at the architecturally-correct cycle, so the hijack window lines up.
    this.read(this.pc); // dummy opcode fetch
    this.read(this.pc); // dummy read
    this.push16(this.pc); // 2 cycles
    // PHP/BRK push with B set; IRQ/NMI push with B clear. U always set.
    this.push((this.p & ~FLAG_B) | FLAG_U | (brk ? FLAG_B : 0)); // 1 cycle
    this.setFlag(FLAG_I, true);
    // An NMI that became pending during the sequence hijacks an IRQ's vector:
    // the pushes already happened (B flag as-is) but the CPU fetches $FFFA. The
    // IRQ line stays asserted and is serviced later.
    if (vector === IRQ_VECTOR && this.nmiPending) {
      this.nmiPending = false;
      vector = NMI_VECTOR;
    }
    this.pc = this.read16(vector); // 2 cycles → 7 total
    notePush({ callSite: this.pc, returnAddr, kind: vector === NMI_VECTOR ? "nmi" : "irq" });
  }

  /** Execute one instruction (servicing a pending interrupt first), advancing
   *  `cycles`. Returns the number of cycles this step consumed. */
  step(): number {
    // Stop before executing a breakpointed instruction (and before servicing a
    // pending interrupt) so the paused PC equals the breakpoint address. The
    // fast path is a single Set.size check when no breakpoints are set.
    if (checkPc(this.pc)) return 0;
    const start = this.cycles;

    // An interrupt latched by the previous instruction's poll runs as its own
    // 7-cycle sequence instead of an opcode fetch. The sequence does no polling
    // of its own, so the handler's first instruction always executes before the
    // next interrupt is taken.
    if (this.serviceInterrupt) {
      this.serviceInterrupt = false;
      if (this.serviceIsNmi) this.nmiPending = false; // consume the NMI edge
      this.interrupt(this.serviceIsNmi ? NMI_VECTOR : IRQ_VECTOR, false);
      this.pollI = this.getFlag(FLAG_I);
      return this.cycles - start;
    }

    // Snapshot the I flag for this instruction's IRQ poll. CLI / SEI / PLP change
    // I during the instruction, so polling against this pre-execute value delays
    // their effect by one instruction (real 6502 behaviour). RTI overrides it
    // with the restored value for immediate effect.
    this.pollI = this.getFlag(FLAG_I);
    this.pollLocked = false;

    this.extra = 0;
    const opcode = this.fetch();
    this.opPc = (this.pc - 1) & 0xffff; // the just-fetched opcode's address
    this.execute(opcode);
    // Bus accesses have ticked one cycle each; charge the instruction's
    // remaining (internal) cycles so the total matches base + penalties.
    const total = CYCLES[opcode]! + this.extra;
    const ticked = this.cycles - start;
    if (ticked < total) this.tick(total - ticked);

    // Poll the interrupt lines as they stood at the second-to-last cycle. BRK is
    // itself an interrupt sequence (it handles any NMI hijack inline) and does
    // not poll, so the handler's first instruction runs before the next one.
    if (opcode !== 0x00) {
      this.serviceIsNmi = this.polledNmi;
      this.serviceInterrupt = this.polledNmi || (this.polledIrq && !this.pollI);
    }
    return this.cycles - start;
  }

  private branch(take: boolean): void {
    const target = this.addr; // REL already resolved
    if (take) {
      this.extra += 1;
      if ((this.pc & 0xff00) !== (target & 0xff00)) {
        this.extra += 1; // page cross: polls normally (before the PCH-fixup cycle)
      } else {
        // Taken, no page cross: the poll already happened before this (operand)
        // cycle and isn't repeated, so an IRQ in the last cycle is ignored.
        this.pollLocked = true;
      }
      this.pc = target;
    }
  }

  /** The page-cross penalty cycle of a read instruction is a dummy read at the
   *  un-fixed address (high byte not yet carried). Performing it — rather than
   *  charging a bare internal cycle — reproduces the read's hardware side
   *  effects (e.g. a dummy read of $2002 clears VBlank). Same cycle count. */
  private pageCost(): void {
    if (this.pageCrossed) this.read(this.dummyAddr);
  }

  /** Write and read-modify-write instructions with an indexed addressing mode
   *  always perform a dummy read of the un-fixed target first — even without a
   *  page cross — so the access count (and side effects) match hardware. */
  private indexedWriteDummy(): void {
    this.read(this.dummyAddr);
  }

  // ── arithmetic ──────────────────────────────────────────────────────────
  private adc(v: number): void {
    const sum = this.a + v + (this.getFlag(FLAG_C) ? 1 : 0);
    this.setFlag(FLAG_C, sum > 0xff);
    this.setFlag(FLAG_V, ((this.a ^ sum) & (v ^ sum) & 0x80) !== 0);
    this.a = sum & 0xff;
    this.setZN(this.a);
  }
  private sbc(v: number): void {
    this.adc(v ^ 0xff);
  }
  private compare(reg: number, v: number): void {
    const diff = (reg - v) & 0x1ff;
    this.setFlag(FLAG_C, reg >= v);
    this.setZN(diff & 0xff);
  }

  // ── shift/rotate (return result; caller stores) ─────────────────────────
  private aslVal(v: number): number {
    this.setFlag(FLAG_C, (v & 0x80) !== 0);
    const r = (v << 1) & 0xff;
    this.setZN(r);
    return r;
  }
  private lsrVal(v: number): number {
    this.setFlag(FLAG_C, (v & 0x01) !== 0);
    const r = v >> 1;
    this.setZN(r);
    return r;
  }
  private rolVal(v: number): number {
    const r = ((v << 1) | (this.getFlag(FLAG_C) ? 1 : 0)) & 0xff;
    this.setFlag(FLAG_C, (v & 0x80) !== 0);
    this.setZN(r);
    return r;
  }
  private rorVal(v: number): number {
    const r = (v >> 1) | (this.getFlag(FLAG_C) ? 0x80 : 0);
    this.setFlag(FLAG_C, (v & 0x01) !== 0);
    this.setZN(r);
    return r;
  }

  private execute(op: number): void {
    switch (op) {
      // ── load / store ────────────────────────────────────────────────────
      case 0xa9:
        this.resolve(Mode.IMM);
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xa5:
        this.resolve(Mode.ZP);
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xb5:
        this.resolve(Mode.ZPX);
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xad:
        this.resolve(Mode.ABS);
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xbd:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xb9:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xa1:
        this.resolve(Mode.IZX);
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xb1:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.a = this.read(this.addr);
        this.setZN(this.a);
        break;

      case 0xa2:
        this.resolve(Mode.IMM);
        this.x = this.read(this.addr);
        this.setZN(this.x);
        break;
      case 0xa6:
        this.resolve(Mode.ZP);
        this.x = this.read(this.addr);
        this.setZN(this.x);
        break;
      case 0xb6:
        this.resolve(Mode.ZPY);
        this.x = this.read(this.addr);
        this.setZN(this.x);
        break;
      case 0xae:
        this.resolve(Mode.ABS);
        this.x = this.read(this.addr);
        this.setZN(this.x);
        break;
      case 0xbe:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.x = this.read(this.addr);
        this.setZN(this.x);
        break;

      case 0xa0:
        this.resolve(Mode.IMM);
        this.y = this.read(this.addr);
        this.setZN(this.y);
        break;
      case 0xa4:
        this.resolve(Mode.ZP);
        this.y = this.read(this.addr);
        this.setZN(this.y);
        break;
      case 0xb4:
        this.resolve(Mode.ZPX);
        this.y = this.read(this.addr);
        this.setZN(this.y);
        break;
      case 0xac:
        this.resolve(Mode.ABS);
        this.y = this.read(this.addr);
        this.setZN(this.y);
        break;
      case 0xbc:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.y = this.read(this.addr);
        this.setZN(this.y);
        break;

      case 0x85:
        this.resolve(Mode.ZP);
        this.write(this.addr, this.a);
        break;
      case 0x95:
        this.resolve(Mode.ZPX);
        this.write(this.addr, this.a);
        break;
      case 0x8d:
        this.resolve(Mode.ABS);
        this.write(this.addr, this.a);
        break;
      case 0x9d:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.write(this.addr, this.a);
        break;
      case 0x99:
        this.resolve(Mode.ABY);
        this.indexedWriteDummy();
        this.write(this.addr, this.a);
        break;
      case 0x81:
        this.resolve(Mode.IZX);
        this.write(this.addr, this.a);
        break;
      case 0x91:
        this.resolve(Mode.IZY);
        this.indexedWriteDummy();
        this.write(this.addr, this.a);
        break;

      case 0x86:
        this.resolve(Mode.ZP);
        this.write(this.addr, this.x);
        break;
      case 0x96:
        this.resolve(Mode.ZPY);
        this.write(this.addr, this.x);
        break;
      case 0x8e:
        this.resolve(Mode.ABS);
        this.write(this.addr, this.x);
        break;

      case 0x84:
        this.resolve(Mode.ZP);
        this.write(this.addr, this.y);
        break;
      case 0x94:
        this.resolve(Mode.ZPX);
        this.write(this.addr, this.y);
        break;
      case 0x8c:
        this.resolve(Mode.ABS);
        this.write(this.addr, this.y);
        break;

      // ── transfers ────────────────────────────────────────────────────────
      case 0xaa:
        this.x = this.a;
        this.setZN(this.x);
        break; // TAX
      case 0xa8:
        this.y = this.a;
        this.setZN(this.y);
        break; // TAY
      case 0xba:
        this.x = this.sp;
        this.setZN(this.x);
        break; // TSX
      case 0x8a:
        this.a = this.x;
        this.setZN(this.a);
        break; // TXA
      case 0x9a:
        this.sp = this.x;
        break; // TXS
      case 0x98:
        this.a = this.y;
        this.setZN(this.a);
        break; // TYA

      // ── stack ────────────────────────────────────────────────────────────
      case 0x48:
        this.push(this.a);
        break; // PHA
      case 0x08:
        this.push(this.p | FLAG_B | FLAG_U);
        break; // PHP
      case 0x68:
        this.a = this.pull();
        this.setZN(this.a);
        break; // PLA
      case 0x28:
        this.p = (this.pull() & ~FLAG_B) | FLAG_U;
        break; // PLP

      // ── logic ────────────────────────────────────────────────────────────
      case 0x29:
        this.resolve(Mode.IMM);
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x25:
        this.resolve(Mode.ZP);
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x35:
        this.resolve(Mode.ZPX);
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x2d:
        this.resolve(Mode.ABS);
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x3d:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x39:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x21:
        this.resolve(Mode.IZX);
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x31:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        break;

      case 0x09:
        this.resolve(Mode.IMM);
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x05:
        this.resolve(Mode.ZP);
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x15:
        this.resolve(Mode.ZPX);
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x0d:
        this.resolve(Mode.ABS);
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x1d:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x19:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x01:
        this.resolve(Mode.IZX);
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x11:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.a |= this.read(this.addr);
        this.setZN(this.a);
        break;

      case 0x49:
        this.resolve(Mode.IMM);
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x45:
        this.resolve(Mode.ZP);
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x55:
        this.resolve(Mode.ZPX);
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x4d:
        this.resolve(Mode.ABS);
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x5d:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x59:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x41:
        this.resolve(Mode.IZX);
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0x51:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.a ^= this.read(this.addr);
        this.setZN(this.a);
        break;

      case 0x24:
        this.resolve(Mode.ZP);
        this.bit(this.read(this.addr));
        break;
      case 0x2c:
        this.resolve(Mode.ABS);
        this.bit(this.read(this.addr));
        break;

      // ── arithmetic ───────────────────────────────────────────────────────
      case 0x69:
        this.resolve(Mode.IMM);
        this.adc(this.read(this.addr));
        break;
      case 0x65:
        this.resolve(Mode.ZP);
        this.adc(this.read(this.addr));
        break;
      case 0x75:
        this.resolve(Mode.ZPX);
        this.adc(this.read(this.addr));
        break;
      case 0x6d:
        this.resolve(Mode.ABS);
        this.adc(this.read(this.addr));
        break;
      case 0x7d:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.adc(this.read(this.addr));
        break;
      case 0x79:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.adc(this.read(this.addr));
        break;
      case 0x61:
        this.resolve(Mode.IZX);
        this.adc(this.read(this.addr));
        break;
      case 0x71:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.adc(this.read(this.addr));
        break;

      case 0xe9:
      case 0xeb:
        this.resolve(Mode.IMM);
        this.sbc(this.read(this.addr));
        break;
      case 0xe5:
        this.resolve(Mode.ZP);
        this.sbc(this.read(this.addr));
        break;
      case 0xf5:
        this.resolve(Mode.ZPX);
        this.sbc(this.read(this.addr));
        break;
      case 0xed:
        this.resolve(Mode.ABS);
        this.sbc(this.read(this.addr));
        break;
      case 0xfd:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.sbc(this.read(this.addr));
        break;
      case 0xf9:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.sbc(this.read(this.addr));
        break;
      case 0xe1:
        this.resolve(Mode.IZX);
        this.sbc(this.read(this.addr));
        break;
      case 0xf1:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.sbc(this.read(this.addr));
        break;

      case 0xc9:
        this.resolve(Mode.IMM);
        this.compare(this.a, this.read(this.addr));
        break;
      case 0xc5:
        this.resolve(Mode.ZP);
        this.compare(this.a, this.read(this.addr));
        break;
      case 0xd5:
        this.resolve(Mode.ZPX);
        this.compare(this.a, this.read(this.addr));
        break;
      case 0xcd:
        this.resolve(Mode.ABS);
        this.compare(this.a, this.read(this.addr));
        break;
      case 0xdd:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.compare(this.a, this.read(this.addr));
        break;
      case 0xd9:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.compare(this.a, this.read(this.addr));
        break;
      case 0xc1:
        this.resolve(Mode.IZX);
        this.compare(this.a, this.read(this.addr));
        break;
      case 0xd1:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.compare(this.a, this.read(this.addr));
        break;

      case 0xe0:
        this.resolve(Mode.IMM);
        this.compare(this.x, this.read(this.addr));
        break;
      case 0xe4:
        this.resolve(Mode.ZP);
        this.compare(this.x, this.read(this.addr));
        break;
      case 0xec:
        this.resolve(Mode.ABS);
        this.compare(this.x, this.read(this.addr));
        break;

      case 0xc0:
        this.resolve(Mode.IMM);
        this.compare(this.y, this.read(this.addr));
        break;
      case 0xc4:
        this.resolve(Mode.ZP);
        this.compare(this.y, this.read(this.addr));
        break;
      case 0xcc:
        this.resolve(Mode.ABS);
        this.compare(this.y, this.read(this.addr));
        break;

      // ── inc / dec ────────────────────────────────────────────────────────
      case 0xe6:
        this.resolve(Mode.ZP);
        this.rmw((v) => (v + 1) & 0xff);
        break;
      case 0xf6:
        this.resolve(Mode.ZPX);
        this.rmw((v) => (v + 1) & 0xff);
        break;
      case 0xee:
        this.resolve(Mode.ABS);
        this.rmw((v) => (v + 1) & 0xff);
        break;
      case 0xfe:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rmw((v) => (v + 1) & 0xff);
        break;
      case 0xc6:
        this.resolve(Mode.ZP);
        this.rmw((v) => (v - 1) & 0xff);
        break;
      case 0xd6:
        this.resolve(Mode.ZPX);
        this.rmw((v) => (v - 1) & 0xff);
        break;
      case 0xce:
        this.resolve(Mode.ABS);
        this.rmw((v) => (v - 1) & 0xff);
        break;
      case 0xde:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rmw((v) => (v - 1) & 0xff);
        break;
      case 0xe8:
        this.x = (this.x + 1) & 0xff;
        this.setZN(this.x);
        break; // INX
      case 0xc8:
        this.y = (this.y + 1) & 0xff;
        this.setZN(this.y);
        break; // INY
      case 0xca:
        this.x = (this.x - 1) & 0xff;
        this.setZN(this.x);
        break; // DEX
      case 0x88:
        this.y = (this.y - 1) & 0xff;
        this.setZN(this.y);
        break; // DEY

      // ── shifts (accumulator + memory) ───────────────────────────────────
      case 0x0a:
        this.a = this.aslVal(this.a);
        break;
      case 0x06:
        this.resolve(Mode.ZP);
        this.rmw((v) => this.aslVal(v));
        break;
      case 0x16:
        this.resolve(Mode.ZPX);
        this.rmw((v) => this.aslVal(v));
        break;
      case 0x0e:
        this.resolve(Mode.ABS);
        this.rmw((v) => this.aslVal(v));
        break;
      case 0x1e:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rmw((v) => this.aslVal(v));
        break;
      case 0x4a:
        this.a = this.lsrVal(this.a);
        break;
      case 0x46:
        this.resolve(Mode.ZP);
        this.rmw((v) => this.lsrVal(v));
        break;
      case 0x56:
        this.resolve(Mode.ZPX);
        this.rmw((v) => this.lsrVal(v));
        break;
      case 0x4e:
        this.resolve(Mode.ABS);
        this.rmw((v) => this.lsrVal(v));
        break;
      case 0x5e:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rmw((v) => this.lsrVal(v));
        break;
      case 0x2a:
        this.a = this.rolVal(this.a);
        break;
      case 0x26:
        this.resolve(Mode.ZP);
        this.rmw((v) => this.rolVal(v));
        break;
      case 0x36:
        this.resolve(Mode.ZPX);
        this.rmw((v) => this.rolVal(v));
        break;
      case 0x2e:
        this.resolve(Mode.ABS);
        this.rmw((v) => this.rolVal(v));
        break;
      case 0x3e:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rmw((v) => this.rolVal(v));
        break;
      case 0x6a:
        this.a = this.rorVal(this.a);
        break;
      case 0x66:
        this.resolve(Mode.ZP);
        this.rmw((v) => this.rorVal(v));
        break;
      case 0x76:
        this.resolve(Mode.ZPX);
        this.rmw((v) => this.rorVal(v));
        break;
      case 0x6e:
        this.resolve(Mode.ABS);
        this.rmw((v) => this.rorVal(v));
        break;
      case 0x7e:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rmw((v) => this.rorVal(v));
        break;

      // ── jumps / branches ────────────────────────────────────────────────
      case 0x4c:
        this.resolve(Mode.ABS);
        this.pc = this.addr;
        break; // JMP abs
      case 0x6c:
        this.resolve(Mode.IND);
        this.pc = this.addr;
        break; // JMP (ind)
      case 0x20: {
        // JSR
        const target = this.fetch16();
        const returnAddr = this.pc;
        this.push16((this.pc - 1) & 0xffff);
        notePush({ callSite: this.opPc, returnAddr, kind: "jsr" });
        this.pc = target;
        break;
      }
      case 0x60:
        // RTS. Like every one-byte opcode it first dummy-reads the byte after
        // the opcode (a real bus access, so a side-effecting address such as
        // $2002 is touched — cpu_exec_space runs an RTS from $2001). Same cycle
        // count; this read replaces one of the instruction's internal cycles.
        notePop();
        this.read(this.pc);
        this.pc = (this.pull16() + 1) & 0xffff;
        break;
      case 0x40: // RTI
        notePop();
        this.read(this.pc); // dummy read of the byte after the opcode (see RTS)
        this.p = (this.pull() & ~FLAG_B) | FLAG_U;
        // RTI's I-flag restore is seen by the IRQ poll immediately (unlike
        // CLI/SEI/PLP), so re-sync the poll snapshot to the restored value.
        this.pollI = this.getFlag(FLAG_I);
        this.pc = this.pull16();
        break;
      case 0x00: {
        // BRK — the signature byte after the opcode is read (and discarded), so
        // the pushes land on the same cycles as a hardware IRQ/NMI sequence.
        this.read(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        this.push16(this.pc);
        this.push(this.p | FLAG_B | FLAG_U);
        this.setFlag(FLAG_I, true);
        notePush({ callSite: this.opPc, returnAddr: this.pc, kind: "brk" });
        // An NMI asserted during the pushes hijacks BRK's vector (B stays set).
        let vec = IRQ_VECTOR;
        if (this.nmiPending) {
          this.nmiPending = false;
          vec = NMI_VECTOR;
        }
        this.pc = this.read16(vec);
        break;
      }

      case 0x10:
        this.resolve(Mode.REL);
        this.branch(!this.getFlag(FLAG_N));
        break; // BPL
      case 0x30:
        this.resolve(Mode.REL);
        this.branch(this.getFlag(FLAG_N));
        break; // BMI
      case 0x50:
        this.resolve(Mode.REL);
        this.branch(!this.getFlag(FLAG_V));
        break; // BVC
      case 0x70:
        this.resolve(Mode.REL);
        this.branch(this.getFlag(FLAG_V));
        break; // BVS
      case 0x90:
        this.resolve(Mode.REL);
        this.branch(!this.getFlag(FLAG_C));
        break; // BCC
      case 0xb0:
        this.resolve(Mode.REL);
        this.branch(this.getFlag(FLAG_C));
        break; // BCS
      case 0xd0:
        this.resolve(Mode.REL);
        this.branch(!this.getFlag(FLAG_Z));
        break; // BNE
      case 0xf0:
        this.resolve(Mode.REL);
        this.branch(this.getFlag(FLAG_Z));
        break; // BEQ

      // ── flag ops ─────────────────────────────────────────────────────────
      case 0x18:
        this.setFlag(FLAG_C, false);
        break; // CLC
      case 0x38:
        this.setFlag(FLAG_C, true);
        break; // SEC
      case 0x58:
        this.setFlag(FLAG_I, false);
        break; // CLI
      case 0x78:
        this.setFlag(FLAG_I, true);
        break; // SEI
      case 0xb8:
        this.setFlag(FLAG_V, false);
        break; // CLV
      case 0xd8:
        this.setFlag(FLAG_D, false);
        break; // CLD
      case 0xf8:
        this.setFlag(FLAG_D, true);
        break; // SED

      // ── NOPs (official + unofficial multi-byte) ─────────────────────────
      case 0xea:
      case 0x1a:
      case 0x3a:
      case 0x5a:
      case 0x7a:
      case 0xda:
      case 0xfa:
        break;
      case 0x80:
      case 0x82:
      case 0x89:
      case 0xc2:
      case 0xe2:
        this.resolve(Mode.IMM);
        break;
      case 0x04:
      case 0x44:
      case 0x64:
        this.resolve(Mode.ZP);
        break;
      case 0x14:
      case 0x34:
      case 0x54:
      case 0x74:
      case 0xd4:
      case 0xf4:
        this.resolve(Mode.ZPX);
        break;
      case 0x0c:
        this.resolve(Mode.ABS);
        break;
      case 0x1c:
      case 0x3c:
      case 0x5c:
      case 0x7c:
      case 0xdc:
      case 0xfc:
        this.resolve(Mode.ABX);
        this.pageCost();
        this.read(this.addr); // unofficial NOP still performs (and discards) the read
        break;

      // ── unofficial: combined ops ────────────────────────────────────────
      case 0xa7:
        this.resolve(Mode.ZP);
        this.lax();
        break;
      case 0xb7:
        this.resolve(Mode.ZPY);
        this.lax();
        break;
      case 0xaf:
        this.resolve(Mode.ABS);
        this.lax();
        break;
      case 0xbf:
        this.resolve(Mode.ABY);
        this.pageCost();
        this.lax();
        break;
      case 0xa3:
        this.resolve(Mode.IZX);
        this.lax();
        break;
      case 0xb3:
        this.resolve(Mode.IZY);
        this.pageCost();
        this.lax();
        break;

      case 0x87:
        this.resolve(Mode.ZP);
        this.write(this.addr, this.a & this.x);
        break; // SAX
      case 0x97:
        this.resolve(Mode.ZPY);
        this.write(this.addr, this.a & this.x);
        break;
      case 0x8f:
        this.resolve(Mode.ABS);
        this.write(this.addr, this.a & this.x);
        break;
      case 0x83:
        this.resolve(Mode.IZX);
        this.write(this.addr, this.a & this.x);
        break;

      case 0xc7:
        this.resolve(Mode.ZP);
        this.dcp();
        break;
      case 0xd7:
        this.resolve(Mode.ZPX);
        this.dcp();
        break;
      case 0xcf:
        this.resolve(Mode.ABS);
        this.dcp();
        break;
      case 0xdf:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.dcp();
        break;
      case 0xdb:
        this.resolve(Mode.ABY);
        this.indexedWriteDummy();
        this.dcp();
        break;
      case 0xc3:
        this.resolve(Mode.IZX);
        this.dcp();
        break;
      case 0xd3:
        this.resolve(Mode.IZY);
        this.indexedWriteDummy();
        this.dcp();
        break;

      case 0xe7:
        this.resolve(Mode.ZP);
        this.isc();
        break;
      case 0xf7:
        this.resolve(Mode.ZPX);
        this.isc();
        break;
      case 0xef:
        this.resolve(Mode.ABS);
        this.isc();
        break;
      case 0xff:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.isc();
        break;
      case 0xfb:
        this.resolve(Mode.ABY);
        this.indexedWriteDummy();
        this.isc();
        break;
      case 0xe3:
        this.resolve(Mode.IZX);
        this.isc();
        break;
      case 0xf3:
        this.resolve(Mode.IZY);
        this.indexedWriteDummy();
        this.isc();
        break;

      case 0x07:
        this.resolve(Mode.ZP);
        this.slo();
        break;
      case 0x17:
        this.resolve(Mode.ZPX);
        this.slo();
        break;
      case 0x0f:
        this.resolve(Mode.ABS);
        this.slo();
        break;
      case 0x1f:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.slo();
        break;
      case 0x1b:
        this.resolve(Mode.ABY);
        this.indexedWriteDummy();
        this.slo();
        break;
      case 0x03:
        this.resolve(Mode.IZX);
        this.slo();
        break;
      case 0x13:
        this.resolve(Mode.IZY);
        this.indexedWriteDummy();
        this.slo();
        break;

      case 0x27:
        this.resolve(Mode.ZP);
        this.rla();
        break;
      case 0x37:
        this.resolve(Mode.ZPX);
        this.rla();
        break;
      case 0x2f:
        this.resolve(Mode.ABS);
        this.rla();
        break;
      case 0x3f:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rla();
        break;
      case 0x3b:
        this.resolve(Mode.ABY);
        this.indexedWriteDummy();
        this.rla();
        break;
      case 0x23:
        this.resolve(Mode.IZX);
        this.rla();
        break;
      case 0x33:
        this.resolve(Mode.IZY);
        this.indexedWriteDummy();
        this.rla();
        break;

      case 0x47:
        this.resolve(Mode.ZP);
        this.sre();
        break;
      case 0x57:
        this.resolve(Mode.ZPX);
        this.sre();
        break;
      case 0x4f:
        this.resolve(Mode.ABS);
        this.sre();
        break;
      case 0x5f:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.sre();
        break;
      case 0x5b:
        this.resolve(Mode.ABY);
        this.indexedWriteDummy();
        this.sre();
        break;
      case 0x43:
        this.resolve(Mode.IZX);
        this.sre();
        break;
      case 0x53:
        this.resolve(Mode.IZY);
        this.indexedWriteDummy();
        this.sre();
        break;

      case 0x67:
        this.resolve(Mode.ZP);
        this.rra();
        break;
      case 0x77:
        this.resolve(Mode.ZPX);
        this.rra();
        break;
      case 0x6f:
        this.resolve(Mode.ABS);
        this.rra();
        break;
      case 0x7f:
        this.resolve(Mode.ABX);
        this.indexedWriteDummy();
        this.rra();
        break;
      case 0x7b:
        this.resolve(Mode.ABY);
        this.indexedWriteDummy();
        this.rra();
        break;
      case 0x63:
        this.resolve(Mode.IZX);
        this.rra();
        break;
      case 0x73:
        this.resolve(Mode.IZY);
        this.indexedWriteDummy();
        this.rra();
        break;

      // ── unofficial: immediate combined-ALU ──────────────────────────────
      case 0x0b: // ANC — AND #imm, then copy bit 7 into C
      case 0x2b:
        this.resolve(Mode.IMM);
        this.a &= this.read(this.addr);
        this.setZN(this.a);
        this.setFlag(FLAG_C, (this.a & 0x80) !== 0);
        break;
      case 0x4b: // ALR (ASR) — AND #imm, then LSR A
        this.resolve(Mode.IMM);
        this.a &= this.read(this.addr);
        this.setFlag(FLAG_C, (this.a & 0x01) !== 0);
        this.a >>= 1;
        this.setZN(this.a);
        break;
      case 0x6b: // ARR — AND #imm, then ROR A, with its own C/V rules
        this.resolve(Mode.IMM);
        this.arr(this.read(this.addr));
        break;
      case 0xcb: // SBX (AXS) — X = (A & X) - #imm, C from the compare
        this.resolve(Mode.IMM);
        this.sbx(this.read(this.addr));
        break;
      case 0x8b: // ANE (XAA) — unstable; uses the analog magic constant
        this.resolve(Mode.IMM);
        this.a = (this.a | UNSTABLE_MAGIC) & this.x & this.read(this.addr);
        this.setZN(this.a);
        break;
      case 0xab: // LXA (LAX #imm) — unstable
        this.resolve(Mode.IMM);
        this.a = this.x = (this.a | UNSTABLE_MAGIC) & this.read(this.addr);
        this.setZN(this.a);
        break;

      // ── unofficial: unstable stores (reg AND high-byte-of-base+1) + LAS ──
      case 0x9c: // SHY abs,X
        this.storeHigh(this.fetch16(), this.x, this.y);
        break;
      case 0x9e: // SHX abs,Y
        this.storeHigh(this.fetch16(), this.y, this.x);
        break;
      case 0x9f: // SHA (AHX) abs,Y
        this.storeHigh(this.fetch16(), this.y, this.a & this.x);
        break;
      case 0x93: // SHA (AHX) (ind),Y
        this.storeHigh(this.read16Bug(this.fetch()), this.y, this.a & this.x);
        break;
      case 0x9b: // TAS (SHS) — SP = A & X, then store SP & (high+1)
        this.sp = this.a & this.x;
        this.storeHigh(this.fetch16(), this.y, this.sp);
        break;
      case 0xbb: // LAS (LAR) — A = X = SP = mem & SP
        this.resolve(Mode.ABY);
        this.pageCost();
        this.sp &= this.read(this.addr);
        this.a = this.x = this.sp;
        this.setZN(this.a);
        break;

      default:
        // The remaining opcodes are all KIL/JAM (0x02, 0x12, … 0xF2), which
        // halt the 6502: re-point at the opcode so it "executes" forever
        // (consuming cycles, freezing the program) rather than crashing.
        this.pc = (this.pc - 1) & 0xffff;
        break;
    }
  }

  private bit(v: number): void {
    this.setFlag(FLAG_Z, (this.a & v) === 0);
    this.setFlag(FLAG_V, (v & FLAG_V) !== 0);
    this.setFlag(FLAG_N, (v & FLAG_N) !== 0);
  }
  private rmw(fn: (v: number) => number): void {
    const v = this.read(this.addr);
    this.write(this.addr, v); // dummy write of the un-modified value (RMW writes twice)
    const r = fn(v);
    this.write(this.addr, r);
    this.setZN(r);
  }
  private lax(): void {
    this.a = this.x = this.read(this.addr);
    this.setZN(this.a);
  }
  private arr(imm: number): void {
    this.a &= imm;
    this.a = (this.a >> 1) | (this.getFlag(FLAG_C) ? 0x80 : 0);
    this.setZN(this.a);
    this.setFlag(FLAG_C, (this.a & 0x40) !== 0);
    this.setFlag(FLAG_V, (((this.a >> 6) ^ (this.a >> 5)) & 1) !== 0);
  }
  private sbx(imm: number): void {
    const t = this.a & this.x;
    this.setFlag(FLAG_C, t >= imm);
    this.x = (t - imm) & 0xff;
    this.setZN(this.x);
  }
  /** SHA/SHX/SHY/TAS store: value = `reg & (baseHigh + 1)`. When the Y/X index
   *  carries into a new page the target's high byte is corrupted to that value
   *  (the documented unstable-store quirk blargg's 07-abs_xy probes). */
  private storeHigh(base: number, index: number, reg: number): void {
    const effLo = (base & 0xff) + index;
    this.read((base & 0xff00) | (effLo & 0xff)); // dummy read at the un-fixed address
    const value = reg & (((base >> 8) + 1) & 0xff);
    const hi = effLo > 0xff ? value : base >> 8;
    this.write(((hi << 8) | (effLo & 0xff)) & 0xffff, value);
  }
  private dcp(): void {
    const orig = this.read(this.addr);
    this.write(this.addr, orig); // dummy write of the un-modified value
    const v = (orig - 1) & 0xff;
    this.write(this.addr, v);
    this.compare(this.a, v);
  }
  private isc(): void {
    const orig = this.read(this.addr);
    this.write(this.addr, orig); // dummy write of the un-modified value
    const v = (orig + 1) & 0xff;
    this.write(this.addr, v);
    this.sbc(v);
  }
  private slo(): void {
    const orig = this.read(this.addr);
    this.write(this.addr, orig); // dummy write of the un-modified value
    const v = this.aslVal(orig);
    this.write(this.addr, v);
    this.a |= v;
    this.setZN(this.a);
  }
  private rla(): void {
    const orig = this.read(this.addr);
    this.write(this.addr, orig); // dummy write of the un-modified value
    const v = this.rolVal(orig);
    this.write(this.addr, v);
    this.a &= v;
    this.setZN(this.a);
  }
  private sre(): void {
    const orig = this.read(this.addr);
    this.write(this.addr, orig); // dummy write of the un-modified value
    const v = this.lsrVal(orig);
    this.write(this.addr, v);
    this.a ^= v;
    this.setZN(this.a);
  }
  private rra(): void {
    const orig = this.read(this.addr);
    this.write(this.addr, orig); // dummy write of the un-modified value
    const v = this.rorVal(orig);
    this.write(this.addr, v);
    this.adc(v);
  }
}
