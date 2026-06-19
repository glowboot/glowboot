/**
 * ARM7TDMI top-level CPU.
 *
 * Owns the register file and a borrowed reference to the memory bus.
 * `step()` runs exactly one instruction from the address in `regs.r[15]`,
 * dispatching to the ARM or Thumb step routine depending on CPSR.T.
 *
 * Before each instruction the step routine polls for a pending IRQ
 * and (when CPSR.I is clear) performs the standard ARM exception
 * entry: switch to IRQ mode, save CPSR to SPSR_irq, set I + clear T,
 * set LR_irq to the return address, jump PC to 0x18.
 *
 * The BIOS vector hop at 0x18 → user handler is HLE'd inline so we
 * don't have to ship Nintendo BIOS code: when the CPU lands on the
 * canonical BIOS entry / exit PCs we run the equivalent push / pop /
 * mode-return sequence directly. The user handler pointer is read
 * from 0x03007FFC (where games install it; the real BIOS reads its
 * mirror at 0x03FFFFFC).
 */

import { checkGbaPc } from "../debug/breakpoints.js";
import { notePushGba } from "../debug/call-stack.js";
import type { MemoryBus } from "../memory/bus.js";
import type { InterruptController } from "../memory/interrupts.js";
import type { BiosHandler } from "../memory/mapped-bus.js";
import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import { stepArm } from "./arm.js";
import { CPSR_I, CPSR_T, MODE_IRQ } from "./registers.js";
import { ArmRegisters } from "./registers.js";
import { stepThumb } from "./thumb.js";

/** ARM exception vectors that we HLE because there is no BIOS ROM. */
const BIOS_IRQ_ENTRY = 0x00000018;
const BIOS_IRQ_EXIT = 0x00000128;
/** IWRAM end-4 — where games install their IRQ handler pointer. Real
 *  BIOS reads its 0x03FFFFFC IWRAM-mirror address; our memory map
 *  mirrors IWRAM the same way (`mapped-bus.ts` adds it with a 16 MB
 *  mirror window) so either address would land on the same byte; we
 *  use the canonical 0x03007FFC for clarity. */
const IRQ_HANDLER_PTR = 0x03007ffc;

export class ArmCpu {
  readonly regs = new ArmRegisters();

  /** Optional interrupt source. When set, `step()` checks for a
   *  pending IRQ before each instruction. Left unset on bare-CPU
   *  unit tests (FlatBus); always set when the CPU runs through the
   *  full memory map. */
  interrupts: InterruptController | null = null;

  /** Set by BIOS Halt / IntrWait. When true, `step()` is a no-op
   *  until the appropriate IRQ wakes the CPU. The PPU / APU / timer
   *  keep ticking around the halt, so the IRQ source eventually
   *  triggers. */
  halted = false;

  /** Cycles spent in halt / IntrWait since the last reset. Reset by
   *  `Gba.runFrame` each frame so the host can compute a per-frame
   *  CPU load metric (`1 - haltedCycles / totalCycles`). Transient —
   *  not part of the serialised state. Mirrors the GB CPU's
   *  `haltedCycles` field. */
  haltedCycles = 0;

  /** Mask of IRQ bits (in IF layout) IntrWait is waiting on. The CPU
   *  releases halt when the BIOS interrupt-check flag at 0x03007FF8
   *  has any of these bits set (the user's IRQ handler ORs consumed
   *  IF bits into that flag per the standard template). Halt with
   *  mask = 0 = plain SWI-0x02 Halt; mask = N = IntrWait. */
  intrWaitMask = 0;

  /** True when a real BIOS image is loaded. Gates the HLE bypass:
   *  with a BIOS, SWIs go straight to vector 0x08 (BIOS executes the
   *  handler) and the IRQ entry / exit HLE hooks at 0x18 / 0x128 are
   *  skipped so the real BIOS code runs there too. */
  hasBios = false;

  /** BIOS handler reference, set by the Gba owner. The CPU updates
   *  `biosOpenBus` on every instruction fetch from the BIOS region
   *  so out-of-BIOS reads can return the latched prefetch value. */
  biosHandler: BiosHandler | null = null;

  /** Number of cycles the most recent `step()` consumed. Used by
   *  `Gba.runFrame` to drive PPU / APU / timer ticks at the correct
   *  rate. The default is 4 (= 1 PPU dot) — the legacy "1 instruction
   *  = 1 dot" assumption. Individual instruction paths can refine
   *  this for cycle-accurate timing without changing the dispatcher
   *  structure. */
  lastCycles = 4;

  /** Cycles an UNRELEASED halted step consumes. `Gba.runFrame` sets
   *  this to the exact distance to the next IRQ-capable event before
   *  each halted step (see the halt gate in `step`); every other
   *  caller leaves the legacy 4-cycle no-op width. Transient — not
   *  serialised. */
  haltCycleBudget = 4;

  /** Latched IRQ-pending state from the END of the previous step.
   *  Real ARM7TDMI samples the IRQ line one cycle and then takes the
   *  exception at the NEXT instruction boundary — meaning a raise
   *  triggered by side-effects of instruction N (e.g. a timer-overflow
   *  caused by the cycles N consumed) can't preempt instruction N+1;
   *  the earliest delivery is at the boundary between N+1 and N+2. We
   *  approximate that by sampling `interrupts.pending` AFTER the step
   *  body and only delivering on the next step. mgba-suite timer-irq
   *  verifies this — without the delay, the IRQ fires before the
   *  follow-up `strh` that reprograms the reload, and the counter we
   *  ultimately read is constant regardless of how many nops the test
   *  inserts. */
  private irqDeliverPending = false;

  /** Three-deep instruction prefetch FIFO modelling ARM7TDMI's
   *  three-stage pipeline (Fetch / Decode / Execute). `prefetch0` is
   *  the instruction at `prefetchPc`, `prefetch1` is at +instrSize,
   *  `prefetch2` is at +2*instrSize. The slots are populated 2 ahead
   *  of the currently-executing instruction so a STR that overwrites
   *  the next two instructions in memory still sees the old opcodes
   *  in the FIFO — the behaviour jsmolka-nes test 1 verifies.
   *
   *  Invalidated on any non-linear PC change (branches, exception
   *  entry / exit, LDM with PC in rlist, etc.). The post-step PC
   *  comparison in `step()` catches most; manual invalidation handles
   *  the exception-vector path. */
  private prefetchValid = false;
  private prefetchPc = 0;
  private prefetchThumb = false;
  private prefetch0 = 0;
  private prefetch1 = 0;
  private prefetch2 = 0;

  /** After a cache-miss refill, the next two cache-hit instructions
   *  (prefetch1 / prefetch2) are already in the CPU's pipeline — the
   *  cart bus was paid for fetching them via `cacheMissCost`. Their
   *  consumption is a pipeline shift, not a cart-bus transfer, so
   *  `fetchCost` for those two steps must be 0. This counter tracks
   *  how many such "free" fetches are pending; gated to 0 on prefetch
   *  invalidation (branch, exception, etc.). */
  private refillFreeFetches = 0;

  /** CPSR mode bits captured at the START of the previous `step()`.
   *  Used to detect `IRQ → non-IRQ` transitions — i.e. the moment the
   *  cart's IRQ handler finishes and CPSR restores from SPSR. Mirrors
   *  the IntrWait re-halt check that `hleBiosIrqExit` does for the
   *  HLE-BIOS exit at 0x128, but works for the real-BIOS path too
   *  (where the exit goes through native BIOS code and our HLE hook
   *  never fires). Defaults to SYS — a fresh boot starts in SYS, not
   *  IRQ, so the first step never triggers the transition. */
  private prevStepMode = 0x1f;

  /** True when the IRQ currently being serviced was delivered by
   *  RELEASING an IntrWait halt (vs firing while the cart runs normal
   *  code). Only then should the IRQ-exit re-halt fire — otherwise we'd
   *  wrongly re-halt / steal the BIOS_INTR_CHECK flag from carts that
   *  run their own code with a stale intrWaitMask (2006 FIFA World Cup,
   *  Dead to Rights, Bee Game, Franklin all hang otherwise). Set in
   *  takeIrq, consumed at the IRQ→non-IRQ transition. */
  private irqFromIntrWaitHalt = false;

  /** r15 at the start of the previous `step()`. Used to confirm an
   *  IRQ→non-IRQ transition was caused by a BIOS instruction (the real
   *  IRQ-return epilogue, PC < 0x4000) rather than a cart-code mode
   *  switch. libgba handlers trampoline IRQ→SYS mid-handler from cart
   *  code; without this check the IRQ-exit re-halt fires on that
   *  trampoline and freezes the handler before it services the IRQ
   *  (Bee Game, Franklin). Defaults outside BIOS so a fresh boot's
   *  first transition can't spuriously qualify. */
  private prevStepPc = 0x08000000;

  /** Mark the prefetch buffer stale. Called after any code path that
   *  changes PC outside the normal stepArm/stepThumb flow (IRQ entry,
   *  HLE entry/exit, etc.). Also invalidates the bus-side sequential-
   *  fetch tracker so the next fetch pays the N-cycle cost (matching
   *  real hardware: a non-sequential cart-ROM fetch flushes the
   *  prefetch FIFO and stalls). */
  invalidatePrefetch(): void {
    this.prefetchValid = false;
    this.bus.lastInstrFetchAddr = -1;
    this.refillFreeFetches = 0;
  }

  /** Open-bus value for I/O / unmapped reads — the prefetched ARM
   *  opcode at PC+8 (= `prefetch2`). Modelled on real ARM7TDMI's
   *  three-stage pipeline: when an instruction at A is executing, the
   *  fetched-but-not-yet-decoded word lives at A+8 and that's what an
   *  open-bus read returns on the data bus.
   *
   *  Thumb mode: the FIFO stores 16-bit values, and the next halfword
   *  past `prefetch2` isn't cached. Approximate by replicating the
   *  low half across the word — accurate enough for the common
   *  "write known value, read back" tests in the field. */
  currentOpenBus(): number {
    if (!this.prefetchValid) return 0;
    if (this.prefetchThumb) {
      const lo = this.prefetch2 & 0xffff;
      return lo | (lo << 16) | 0;
    }
    return this.prefetch2 | 0;
  }

  constructor(
    readonly bus: MemoryBus,
    entry = 0
  ) {
    this.regs.r[15] = entry | 0;
  }

  step(): void {
    // Reset cycle cost for this step. Individual instruction paths
    // can refine; anything that returns early (halt / IRQ entry) gets
    // the default 4 cycles (= 1 PPU dot) of "the rest of the world
    // ticked but the CPU did nothing visible".
    this.lastCycles = 4;
    // IRQ-exit IntrWait re-halt check, real-BIOS path. With HLE BIOS the
    // equivalent logic lives in `hleBiosIrqExit` (PC=0x128); running both
    // would double-process every IntrWait exit and corrupt the cart. With
    // a real BIOS the IRQ epilogue is native BIOS code our hook never
    // sees, so we mirror the check here by detecting the IRQ → non-IRQ
    // CPSR transition (SPSR_irq just restored). Three gates make it fire
    // ONLY at a genuine IntrWait return:
    //   • hasBios          — HLE has hleBiosIrqExit instead.
    //   • prevStepPc < 0x4000 — the returning instruction was BIOS code,
    //     i.e. the real IRQ epilogue. libgba handlers trampoline IRQ→SYS
    //     mid-handler from CART code; firing on that cart-code transition
    //     re-halts the handler before it services the IRQ, so it never
    //     sees VBlank and IntrWait spins forever (Bee Game, Franklin).
    //   • irqFromIntrWaitHalt — this IRQ was delivered by releasing an
    //     IntrWait halt, not fired while the cart ran its own code with a
    //     stale intrWaitMask (else 2006 FIFA World Cup / Dead to Rights
    //     get spuriously re-halted or robbed of their BIOS_INTR_CHECK).
    // Without the re-halt, libgba carts on a real BIOS race their intros
    // 3× too fast — the SYS-mode IRQ-exit re-halt elsewhere in this
    // file only covers the HLE BIOS path.
    const modeAtEntry = this.regs.cpsr & 0x1f;
    if (this.hasBios && this.prevStepMode === 0x12 && modeAtEntry !== 0x12 && this.prevStepPc >>> 0 < 0x4000) {
      if (this.irqFromIntrWaitHalt && this.intrWaitMask !== 0) {
        const flag = this.bus.read16(0x03007ff8) & 0xffff;
        const flagMatch = (flag & this.intrWaitMask) !== 0;
        // libtonc-style handlers don't OR BIOS_INTR_CHECK; satisfy the
        // wait if the serviced IRQ matches what's being waited on.
        const irqMatch = (this.lastIrqServiced & this.intrWaitMask) !== 0;
        if (flagMatch || irqMatch) {
          if (flagMatch) this.bus.write16(0x03007ff8, flag & ~this.intrWaitMask);
          this.intrWaitMask = 0;
          this.lastIrqServiced = 0;
          // On real hardware the IntrWait SWI's epilogue is the last
          // BIOS code to run before control returns to the cart, so
          // the BIOS open-bus latch holds GBATEK's "after SWI" value.
          // This hook short-circuits that loop tail (the satisfied
          // wait returns straight to cart code), so the organically-
          // tracked latch would keep the "after IRQ" value instead —
          // seed the canonical constant (mgba-suite memory "BIOS
          // load" reads it back).
          if (this.biosHandler !== null) this.biosHandler.biosOpenBus = 0xe3a02004 | 0;
        } else {
          // Wait not satisfied — re-halt until the next IRQ fires. Real
          // BIOS's IntrWait spin loop does the same.
          this.halted = true;
        }
      }
      this.irqFromIntrWaitHalt = false;
    }
    this.prevStepMode = modeAtEntry;
    this.prevStepPc = this.regs.r[15]! >>> 0;
    // Halt / IntrWait gate. Either form returns without stepping
    // until its release condition is met; the surrounding subsystems
    // (PPU, APU, timer) keep ticking and eventually raise an IRQ.
    let releasedFromHalt = false;
    if (this.halted) {
      if (!this.checkHaltRelease()) {
        // Unreleased halt: consume the caller-provided budget — the
        // exact cycle distance to the next event that could raise an
        // IRQ (timer/SIO horizon or PPU event dot), computed by
        // Gba.runFrame each iteration. The wake therefore lands on
        // the event's exact cycle instead of quantizing to a fixed
        // no-op width (mgba-suite timers' IntrWait windows measure
        // this). Callers without horizon knowledge (stepInstruction,
        // runForCycles, bare-CPU tests) leave the budget at the
        // legacy 4 cycles. Mirrored into `haltedCycles` so the
        // host's CPU-load metric counts halt-time correctly.
        this.lastCycles = this.haltCycleBudget | 0;
        this.haltedCycles += this.lastCycles;
        return;
      }
      releasedFromHalt = true;
    }

    // PC breakpoint: latches a hit without executing. Setting
    // lastCycles = 0 stops the periphery from ticking; the surrounding
    // runFrame loop drains the hit and bails so the next frame won't
    // start until the user resumes. The armed-PC logic inside the
    // registry lets a Step press advance past the breakpoint instead
    // of immediately re-triggering it.
    if (checkGbaPc(this.regs.r[15]! >>> 0)) {
      this.lastCycles = 0;
      return;
    }

    // IRQ delivery: edge-triggered ARM exception entry. ARM7TDMI's
    // sample-then-take pattern means a raise caused by side-effects
    // of step N can't preempt step N+1 — the earliest delivery is at
    // the boundary between N+1 and N+2. We approximate that by arming
    // `irqDeliverPending` when we first observe `interrupts.pending`
    // at the start of a step, and only actually taking the IRQ on
    // the NEXT step where it's still pending. The HALT-release path
    // bypasses the delay because the CPU is already paused waiting
    // for the wake edge.
    const ic = this.interrupts;
    if (ic !== null && !this.regs.iFlag && ic.pending) {
      if (this.irqDeliverPending || releasedFromHalt) {
        this.takeIrq(releasedFromHalt);
        this.irqDeliverPending = false;
        // ARM7TDMI exception entry is 2S + 1N = 3 cycles per the TRM,
        // but those 3 cycles ARE the pipeline refill — they get paid
        // on the next step's cache miss (`cacheMissCost`), where they
        // become region-aware (1 cycle each in BIOS, N + 2S in cart).
        // Charge just 1 cycle here for the mode switch / register
        // save so the timers tick during the entry without
        // double-counting the refill. Same shape as the branch /
        // SWI / PC-write paths elsewhere.
        this.bus.flushPrefetchFifo();
        this.lastCycles = 1;
        return;
      }
      this.irqDeliverPending = true;
    } else {
      this.irqDeliverPending = false;
    }
    // BIOS HLE — when the CPU lands on one of the BIOS-vector PCs,
    // run the standard exception entry / exit dance in place of the
    // missing BIOS code. Skipped when a real BIOS is loaded — the
    // BIOS code at 0x18 / 0x128 then runs naturally.
    //
    // Mode-gating: only honour 0x18/0x128 when the CPU is actually in
    // IRQ mode. Without this check, any NOP-slide through the
    // zero-filled BIOS region (e.g. from a corrupt PC or an unhandled
    // jump) reaches PC=0x18 and fires a SPURIOUS HLE IRQ entry that
    // corrupts the IRQ stack and loops forever (Dead to Rights hits
    // this).
    if (!this.hasBios && (this.regs.cpsr & 0x1f) === MODE_IRQ) {
      const pc = (this.regs.r[15]! >>> 0) | 0;
      if (pc === BIOS_IRQ_ENTRY) {
        this.hleBiosIrqEntry();
        return;
      }
      if (pc === BIOS_IRQ_EXIT) {
        this.hleBiosIrqExit();
        return;
      }
    }
    // Prefetch FIFO: load the instruction word from cache when valid,
    // else cache-miss fetch (which also refills `prefetch1` /
    // `prefetch2` two ahead). Real ARM7TDMI's 3-stage pipeline means
    // the next 2 fetches are already in flight while the current
    // instruction executes; if that instruction writes to those
    // upcoming addresses, the FIFO's snapshot is what runs.
    const pc = this.regs.r[15]! | 0;
    const isThumb = this.regs.tFlag;
    const instrSize = isThumb ? 2 : 4;

    // Reset bus state for this step. Done BEFORE the cache miss path
    // so the refill reads' cycle costs survive (real hardware pays for
    // the pipeline refill after a branch; previously we discarded
    // those cycles by resetting again before dispatch).
    this.bus.resetAccessCycles();

    let instr: number;
    let cacheMissCost = 0;
    if (this.prefetchValid && this.prefetchPc === pc && this.prefetchThumb === isThumb) {
      instr = this.prefetch0;
    } else {
      // Cache miss (branch target) — refill all three FIFO slots for OPCODE
      // VALUE correctness (self-modifying code). fetchInstrAt skips
      // chargeAccess.
      instr = this.fetchInstrAt(pc, isThumb);
      this.prefetch1 = this.fetchInstrAt((pc + instrSize) | 0, isThumb);
      this.prefetch2 = this.fetchInstrAt((pc + 2 * instrSize) | 0, isThumb);
      this.prefetchValid = true;
      this.prefetchPc = pc;
      this.prefetchThumb = isThumb;
      this.bus.resetDataAccessTracking();
      this.bus.lastInstrFetchAddr = -1;
      // ROM targets: charge the refill per-step via the prefetch-buffer
      // model (the prefetch unit captures it; lets it engage in short
      // functions). Internal targets (IWRAM/BIOS/etc) have no game-pak
      // prefetch, so the 3-stage pipeline refill is FRONT-LOADED to the branch
      // like real hardware (the next two fetches are prepaid pipeline shifts) —
      // without this the per-step model under-charges internal branches and
      // skews the IWRAM-resident nba-hw-test timer / 128kb-boundary measurement loops.
      const region = (pc >>> 24) & 0xf;
      // EWRAM (region 2) is the one wait-stated internal region: its big
      // refill burst + the two prepaid pipeline shifts make the measurement
      // position-sensitive (inserting a CODE instruction pushes the END read
      // out of the free window → a spurious +cost). Let it use the per-step
      // model like ROM. The other 1-cycle internal regions (IWRAM/BIOS/…) keep
      // the front-loaded refill the IWRAM-resident nba-hw-test / timer loops need.
      if ((region < 8 || region > 0xd) && region !== 2) {
        cacheMissCost = this.bus.cacheMissCost(pc, isThumb) | 0;
        this.refillFreeFetches = 2;
      }
    }

    // BIOS open-bus tracking — ARM7TDMI's prefetch latch holds the
    // word at PC+8 (ARM) / PC+4 (Thumb pair) while executing at PC.
    // Snapshot it for out-of-BIOS reads. The extra read for the high
    // half (Thumb) is pure bookkeeping; snapshot/restore accessCycles
    // around it so the cycle count isn't perturbed.
    if (this.biosHandler !== null && pc >>> 0 < 0x4000) {
      const cyclesBefore = this.bus.accessCycles | 0;
      this.biosHandler.biosOpenBus = isThumb
        ? (this.prefetch2 & 0xffff) | ((this.readInstrAt((pc + 6) | 0, true) & 0xffff) << 16)
        : this.prefetch2 | 0;
      this.bus.accessCycles = cyclesBefore;
    }

    // Per-instruction fetch cycle cost. An internal branch's front-loaded
    // refill (cacheMissCost) puts the cost in this step → 0 here; the next two
    // prepaid pipeline shifts (refillFreeFetches) cost 1; everything else goes
    // through the prefetch-buffer model (hit 1 / in-flight countdown /
    // miss full N/S).
    let fetchCost: number;
    let fetchRegion: number;
    if (cacheMissCost !== 0) {
      fetchCost = 0;
      fetchRegion = (pc >>> 24) & 0xf;
      this.bus.lastInstrFetchAddr = pc | 0;
    } else if (this.refillFreeFetches > 0) {
      this.refillFreeFetches--;
      fetchCost = 1;
      fetchRegion = (pc >>> 24) & 0xf;
      this.bus.lastInstrFetchAddr = pc | 0;
    } else {
      // Tail-charging: the fetch the bus performs during this step is the
      // pipeline tail (pc + 2*instrSize) — the opcode entering the 3-stage
      // pipeline while pc executes, since the fetch pointer leads the executing
      // instruction by two slots. Its cost is what advances the unified clock
      // below.
      const tail = (pc + 2 * instrSize) | 0;
      fetchCost = this.bus.fetchCycleCost(tail, instrSize === 4 ? 32 : 16);
      fetchRegion = (tail >>> 24) & 0xf;
      this.bus.lastInstrFetchAddr = tail;
    }
    // Unified clock: advance bus.now by this instruction's opcode fetch BEFORE
    // executing it, the way real ARM7 charges the fetch as its own bus cycles
    // rather than batching it into the step total — so a mid-instruction timer
    // read samples bus.now with its own fetch already elapsed (no overhang
    // fudge). Only a WAIT-STATED fetch (ROM region 8-D, EWRAM region 2) is
    // visible this way: a 1-cycle internal fetch (IWRAM / BIOS / IO) is fully
    // hidden in the pipeline and does not advance the clock ahead of the read —
    // the IWRAM-resident nba-hw-test timer / 128kb measurement loops verify
    // this. The step-end `bus.now = nowStart + stepCycles` still charges every
    // fetch into the step total; this only governs intra-step visibility.
    if (fetchRegion >= 8 || fetchRegion === 2) {
      this.bus.now = (this.bus.now + fetchCost + cacheMissCost) | 0;
    }

    if (isThumb) {
      stepThumb(this.regs, this.bus, this, instr);
    } else {
      stepArm(this.regs, this.bus, this, instr);
    }

    // The instruction's internal (I-)cycles tick the prefetch countdown like
    // any other elapsed idle time. `lastCycles` here is the
    // handler's internal time incl. the 1-cycle execute baseline, so the
    // idle count is lastCycles - 1; data-access cycles already ticked it in
    // chargeAccess.
    const internalIdle = (this.lastCycles - 1) | 0;
    if (internalIdle > 0) this.bus.tickPrefetch(internalIdle);
    // Total cycles = instruction's internal time + the bus accesses it
    // did + per-instruction fetch cycle + pipeline-refill cycles from
    // a cache miss. Subtract 1 because `lastCycles` already includes
    // the single-cycle baseline for the executed instruction. The
    // prefetch-buffer model in fetchCycleCost yields the prefetch-aware
    // fetch cost directly, so no separate loadPrefetchDelta is needed.
    this.lastCycles = (this.lastCycles + this.bus.accessCycles + fetchCost + cacheMissCost - 1) | 0;

    // Post-step: check whether PC advanced linearly within the same
    // mode. If yes, shift the FIFO and fetch a new tail. If no
    // (branch, mode switch, PC-as-Rd, LDM with PC, etc.), invalidate.
    const pcAfter = this.regs.r[15]! | 0;
    const isThumbAfter = this.regs.tFlag;
    if (isThumbAfter === isThumb && pcAfter === ((pc + instrSize) | 0)) {
      this.prefetch0 = this.prefetch1;
      this.prefetch1 = this.prefetch2;
      // fetchInstrAt skips chargeAccess: this refill happens after
      // lastCycles is already computed, and the next step's
      // resetAccessCycles wipes any cycles charged here. Going through
      // bus.read* would burn the chargeAccess cost (cart-bus
      // sequentiality + 128KB-cross + DMA gates) for nothing.
      this.prefetch2 = this.fetchInstrAt((pcAfter + 2 * instrSize) | 0, isThumb);
      this.prefetchPc = pcAfter;
    } else {
      this.prefetchValid = false;
      this.bus.flushPrefetchFifo();
    }
  }

  private readInstrAt(addr: number, isThumb: boolean): number {
    return isThumb ? this.bus.read16(addr >>> 0) & 0xffff : this.bus.read32(addr >>> 0) | 0;
  }

  /** Raw instruction fetch — used for prefetch FIFO refill where the
   *  access cycles would be discarded next step anyway. Skips
   *  chargeAccess + watchpoint + bitmap-VRAM gate. */
  private fetchInstrAt(addr: number, isThumb: boolean): number {
    return isThumb ? this.bus.fetchHalfword(addr >>> 0) & 0xffff : this.bus.fetchWord(addr >>> 0) | 0;
  }

  /** Decide whether a Halt / IntrWait can release. Returns true to
   *  proceed with the rest of `step()`; false to bail out and let the
   *  surrounding subsystems tick. */
  private checkHaltRelease(): boolean {
    if (this.interrupts === null) {
      // No interrupt source attached — release immediately (matches
      // the "no IRQ controller" path used in some unit tests).
      this.halted = false;
      this.intrWaitMask = 0;
      return true;
    }
    if (this.intrWaitMask !== 0) {
      // IntrWait — three release paths matching real BIOS behaviour:
      //   1. BIOS interrupt-check flag at 0x03007FF8 has any waited-for
      //      bit set. The user's IRQ handler ORs consumed IF bits
      //      there (libgba's IntrMain + the standard libtonc template
      //      both do this). When set, IntrWait is satisfied — clear
      //      the bits and return.
      //   2. An IRQ is pending and deliverable: release halt so the
      //      CPU can take the IRQ and run the user handler. The
      //      handler is what writes the flag; without releasing here
      //      first, we'd deadlock waiting for a flag that needs the
      //      handler to set it. `hleBiosIrqExit` re-halts if the
      //      flag still doesn't have the waited bit after the
      //      handler returns, so IntrWait correctly waits for the
      //      SPECIFIC IRQ even when a different one fires first.
      //   3. (none — fall through, stay halted)
      const flag = this.bus.read16(0x03007ff8) & 0xffff;
      if ((flag & this.intrWaitMask) !== 0) {
        this.bus.write16(0x03007ff8, flag & ~this.intrWaitMask);
        this.halted = false;
        this.intrWaitMask = 0;
        return true;
      }
      if ((this.interrupts.ie & this.interrupts.if_) !== 0 && !this.regs.iFlag) {
        // Release for IRQ delivery; intrWaitMask stays set so the
        // post-handler re-check fires.
        this.halted = false;
        return true;
      }
      return false;
    }
    // Plain Halt — wake on any enabled+pending IRQ, regardless of
    // CPSR.I (Halt ignores the mask; the BIOS just stops the clock).
    if ((this.interrupts.ie & this.interrupts.if_) === 0) return false;
    this.halted = false;
    return true;
  }

  /** ARM exception entry: switch to IRQ mode, save CPSR, mask further
   *  IRQs, clear Thumb, set LR_irq = return address, jump to vector.
   *
   *  Real ARM7TDMI sets LR_irq = address-of-next-instruction + 4 (the
   *  PC value visible to the executing instruction in the prefetch
   *  model). The standard `SUBS PC, LR, #4` exit then resumes at the
   *  next instruction. In our model, post-step `r[15]` already points
   *  at next-to-execute (whether the previous step was a normal
   *  instruction or a halt-causing SWI whose handler returned without
   *  advancing PC), so the same `r[15] + 4` formula applies in both
   *  the halt and non-halt cases.
   *
   *  `fromHalt` records whether this IRQ was delivered by releasing a
   *  halt (vs firing during normal execution); the return-address math
   *  no longer branches on it, but the IntrWait re-halt gate does. */
  private takeIrq(fromHalt = false): void {
    // Set-only (never cleared here) so a nested non-halt IRQ taken from
    // inside an outer IntrWait-halt handler can't reset the flag before
    // the outer IRQ exits. Cleared at the IRQ→non-IRQ transition.
    if (fromHalt && this.intrWaitMask !== 0) this.irqFromIntrWaitHalt = true;
    // Mirror hleBiosIrqEntry's lastIrqServiced accumulation for the
    // real-BIOS path, where that HLE hook never runs — lets the
    // IRQ-exit re-halt satisfy an IntrWait via irqMatch for hand-rolled
    // handlers that don't OR into BIOS_INTR_CHECK.
    if (this.interrupts !== null) {
      this.lastIrqServiced |= (this.interrupts.ie & this.interrupts.if_) | 0;
    }
    const cpsr = this.regs.cpsr;
    const pc = this.regs.r[15]! | 0;
    const returnAddr = (pc + 4) | 0;
    // Call-stack tap: IRQ entry pushes a synthetic frame so the call
    // chain reads "main → IRQ handler @ caller". The conventional
    // `bx lr` exit pops it.
    notePushGba({ callSite: pc >>> 0, returnAddr: returnAddr >>> 0, kind: "irq" });
    this.regs.setMode(MODE_IRQ);
    this.regs.spsr = cpsr;
    this.regs.r[14] = returnAddr;
    this.regs.cpsr = (this.regs.cpsr & ~CPSR_T) | CPSR_I;
    this.regs.r[15] = BIOS_IRQ_ENTRY;
    this.prefetchValid = false;
  }

  /** IRQ bits that were pending (IE & IF) at the most recent BIOS IRQ
   *  entry. Used by `hleBiosIrqExit` to satisfy an IntrWait waiting on
   *  any of these IRQs, even when the user's handler didn't OR them
   *  into BIOS_INTR_CHECK (the libtonc convention). Many commercial
   *  games — Bubble Bobble: Old & New, Bruce Lee, Dead to Rights —
   *  use hand-rolled IRQ handlers that don't follow the convention. */
  lastIrqServiced = 0;

  /** Equivalent of the real-BIOS IRQ-entry preamble:
   *
   *    0x128:  sub  lr, lr, #4
   *    0x12C:  stmfd sp!, {r0-r3, r12, lr}
   *    0x130:  mov  r0, #0x04000000     ; r0 = MMIO base
   *    0x134:  add  lr, pc, #0          ; lr = 0x13C (exit point)
   *    0x138:  ldr  pc, [r0, #-4]       ; jump to user handler @ [0x03FFFFFC]
   *
   *  The user handler sees `r0 = 0x04000000` (so handlers can do
   *  `ldr r0, [r0, #0x200]` to read REG_IE etc. without an explicit
   *  MOV) and `lr = exit-vector` so its closing `bx lr` lands in our
   *  HLE exit code. Cycle cost: ~28 cycles for the 5 instructions +
   *  STMFD's 6-word write burst.
   *
   *  Why r0 matters: Bomberman Tournament (and likely other commercial
   *  carts) ship hand-rolled IRQ handlers that read MMIO via r0
   *  indirection without re-initializing r0 — they trust the BIOS
   *  preamble to have set it. Without this, the handler reads from
   *  garbage addresses, ACKing the wrong IF bits and corrupting game
   *  state across frames. */
  private hleBiosIrqEntry(): void {
    // GBATEK BIOS open-bus: while the cart's handler runs, the latch
    // holds the word the BIOS IRQ dispatch prefetched ("during IRQ" =
    // 0xE25EF004). jsmolka-bios #3 reads it from inside an ISR.
    if (this.biosHandler !== null) this.biosHandler.biosOpenBus = 0xe25ef004 | 0;
    if (this.interrupts !== null) {
      // OR-accumulate across nested IRQ entries: a VBlank handler in
      // SYS mode (cart trampoline switches there after the BIOS save)
      // can be preempted by HBlank / Timer. Without accumulation the
      // inner IRQ overwrites the outer's bits and `lastIrqServiced &
      // intrWaitMask` reports no match at outer-handler exit. Bee
      // Game / Robot Wars / Franklin / Wild Thornberrys all hit this.
      this.lastIrqServiced |= (this.interrupts.ie & this.interrupts.if_) | 0;
    }
    const sp = ((this.regs.r[13]! | 0) - 24) | 0;
    this.bus.write32(sp >>> 0, this.regs.r[0]! | 0);
    this.bus.write32((sp + 4) >>> 0, this.regs.r[1]! | 0);
    this.bus.write32((sp + 8) >>> 0, this.regs.r[2]! | 0);
    this.bus.write32((sp + 12) >>> 0, this.regs.r[3]! | 0);
    this.bus.write32((sp + 16) >>> 0, this.regs.r[12]! | 0);
    this.bus.write32((sp + 20) >>> 0, this.regs.r[14]! | 0);
    this.regs.r[13] = sp;
    // Real BIOS sets r0 to the MMIO base before jumping to the user
    // handler. Many cart IRQ handlers depend on this.
    this.regs.r[0] = 0x04000000 | 0;
    // Set LR to the exit-vector PC so `bx lr` from the user handler
    // returns to our HLE pop / mode-restore.
    this.regs.r[14] = BIOS_IRQ_EXIT;
    this.regs.r[15] = this.bus.read32(IRQ_HANDLER_PTR) >>> 0;
    this.prefetchValid = false;
    // Real BIOS IRQ-entry preamble at 0x18: 5 ARM instructions (1S each)
    // + 1 STMFD pushing 6 regs to IWRAM (6N × 1 cycle IWRAM = 6 cycles)
    // + 1 BX = 3 cycles for pipeline refill. Total ≈ 5 + 6 + 3 = 14 to
    // 18 cycles depending on instruction-fetch wait states. We had 28
    // here originally, but mgba-suite-timer-irq's post-IRQ residual
    // values land 7-8 cycles too high with that figure (got 0x59,
    // expected 0x51/0x52). Empirically 21 cycles lines up with the
    // hardware values for the plateau cells without regressing the
    // tests that previously gated on 28.
    this.lastCycles = 21;
  }

  /** Equivalent of `ldmfd sp!, {r0-r3, r12, lr}; subs pc, lr, #4`.
   *  Restores the caller-saved registers and returns from the IRQ
   *  exception, restoring CPSR from SPSR_irq. */
  private hleBiosIrqExit(): void {
    // GBATEK BIOS open-bus: once the BIOS IRQ epilogue has run, the
    // latch holds its prefetched word ("after IRQ" = 0xE55EC002).
    if (this.biosHandler !== null) this.biosHandler.biosOpenBus = 0xe55ec002 | 0;
    const sp = this.regs.r[13]! | 0;
    this.regs.r[0] = this.bus.read32(sp >>> 0) | 0;
    this.regs.r[1] = this.bus.read32((sp + 4) >>> 0) | 0;
    this.regs.r[2] = this.bus.read32((sp + 8) >>> 0) | 0;
    this.regs.r[3] = this.bus.read32((sp + 12) >>> 0) | 0;
    this.regs.r[12] = this.bus.read32((sp + 16) >>> 0) | 0;
    this.regs.r[14] = this.bus.read32((sp + 20) >>> 0) | 0;
    this.regs.r[13] = (sp + 24) | 0;
    // subs pc, lr, #4: restore CPSR from SPSR (auto-switches mode and
    // T-bit), then PC = LR - 4 (the address the interrupted code was
    // at when we trapped, accounting for ARM's prefetch).
    const savedSpsr = this.regs.spsr;
    const returnAddr = this.regs.r[14]! | 0;
    this.regs.setMode(savedSpsr & 0x1f);
    this.regs.cpsr = savedSpsr;
    this.regs.r[15] = (returnAddr - 4) >>> 0;
    this.prefetchValid = false;

    // If we're returning from an IRQ in the middle of an IntrWait,
    // decide whether to wake or re-halt. Two satisfaction paths:
    //   1. BIOS_INTR_CHECK has any waited bit set — the libtonc /
    //      devkitARM convention, in which the user handler ORs the
    //      consumed IF bits into [0x03007FF8] before returning.
    //   2. The IRQ that just fired matches the wait mask — covers
    //      commercial games that ship hand-rolled handlers which
    //      don't update the BIOS flag. `lastIrqServiced` was snapshot
    //      at IRQ entry from (IE & IF), so it captures what the
    //      handler is about to service even though the handler has
    //      since ack'd IF.
    // Only run the IntrWait-satisfaction / re-halt dance when this
    // IRQ exit returns to top-level cart code (USER or SYS mode),
    // NOT when it returns to IRQ mode (= nested IRQ that preempted
    // an outer handler). Setting `halted=true` while still inside an
    // outer handler would freeze the cart mid-handler.
    //
    // Peter Pan + Tom and Jerry Tales call VBlankIntrWait from SYS
    // mode (libgba-style startup leaves cart code in SYS, not USER),
    // so every HBlank IRQ during their VBlank wait was escaping the
    // re-halt check, the cart looped back to VBlankIntrWait
    // immediately, and the intro raced ~3× too fast. Real BIOS
    // IntrWait doesn't gate on caller mode — it spins on a flag —
    // so the only case we genuinely must avoid is the nested-IRQ
    // case (SPSR == IRQ mode 0x12).
    const savedMode = savedSpsr & 0x1f;
    const isNestedIrqReturn = savedMode === 0x12;
    if (!isNestedIrqReturn && this.intrWaitMask !== 0) {
      const flag = this.bus.read16(0x03007ff8) & 0xffff;
      const flagMatch = (flag & this.intrWaitMask) !== 0;
      const irqMatch = (this.lastIrqServiced & this.intrWaitMask) !== 0;
      if (flagMatch || irqMatch) {
        if (flagMatch) this.bus.write16(0x03007ff8, flag & ~this.intrWaitMask);
        this.intrWaitMask = 0;
        this.lastIrqServiced = 0;
        // A satisfied IntrWait returns to the cart through the SWI
        // epilogue, which runs AFTER the IRQ epilogue — the latch
        // must end at the "after SWI" value, overriding the
        // "after IRQ" constant seeded at the top of this method.
        if (this.biosHandler !== null) this.biosHandler.biosOpenBus = 0xe3a02004 | 0;
      } else if (this.interrupts !== null) {
        // Real BIOS IntrWait runs a polling loop around Halt: each
        // iteration ORs the wait-mask back into IE, then halts. The
        // cart's user IRQ handler is free to clear IE bits during
        // servicing — the BIOS's next loop iteration re-enables them.
        // Dead to Rights' handler clears IE.bit0 around its VBlank
        // path and would hang forever without this re-OR.
        this.interrupts.ie = (this.interrupts.ie | this.intrWaitMask) & 0x3fff;
        this.halted = true;
      } else {
        this.halted = true;
      }
    }
    // Real BIOS IRQ exit (~5 instructions: LDMFD + SUBS PC,LR,#4) runs
    // in IWRAM. See `hleBiosIrqEntry` cycle-cost note.
    this.lastCycles = 18;
  }

  serialize(w: GbaStateWriter): void {
    this.regs.serialize(w);
    w.bool(this.halted);
    w.u32(this.intrWaitMask);
  }

  deserialize(r: GbaStateReader): void {
    this.regs.deserialize(r);
    this.halted = r.bool();
    this.intrWaitMask = r.u32();
  }
}
