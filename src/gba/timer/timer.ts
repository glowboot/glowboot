/**
 * GBA timers — 4 channels at 0x04000100..0x0400010F.
 *
 * Each timer is two 16-bit registers (4 bytes per channel):
 *   +0  TMxCNT_L  Counter (read) / reload value (write).
 *   +2  TMxCNT_H  Control:
 *                   0-1  Prescaler  (0=1, 1=64, 2=256, 3=1024 CPU cycles)
 *                   2    Count-up timing (cascade) — timers 1/2/3 only.
 *                        When set, the timer increments on the previous
 *                        timer's overflow instead of on a prescaler tick.
 *                   6    IRQ enable on overflow.
 *                   7    Timer enable.
 *
 * Behaviour:
 *   - Reload: TMxCNT_L writes set the reload value. The live counter
 *     is loaded from reload only when the timer transitions
 *     disabled → enabled (TMxCNT_H bit 7 0→1) and on each overflow.
 *   - Tick: when enabled and NOT in cascade mode, the timer's
 *     prescaler accumulates CPU cycles. Each `prescaler` cycles, the
 *     counter increments.
 *   - Overflow (counter == 0x10000): counter = reload; if IRQ
 *     enabled raise IRQ_TIMERx; cascade: if the next timer is enabled
 *     AND in cascade mode, tick it once.
 *
 * Drives the APU's Direct Sound FIFOs: Timer 0 overflow pops one
 * sample from whichever FIFO is bound to Timer 0 by SOUNDCNT_H; same
 * for Timer 1. The APU exposes the pop hook through `onTimerOverflow`.
 */

import type { Apu } from "../apu/apu.js";
import { type InterruptController, IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER2, IRQ_TIMER3 } from "../memory/interrupts.js";
import { BaseIoHandler } from "../memory/io-handler-base.js";
import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";

const PRESCALERS = [1, 64, 256, 1024] as const;
const TIMER_IRQS = [IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER2, IRQ_TIMER3] as const;

const CH_SIZE = 4;
const TM_L = 0x0;
const TM_H = 0x2;

const CNT_PRESCALER_MASK = 0x3;
const CNT_CASCADE = 1 << 2;
const CNT_IRQ = 1 << 6;
const CNT_ENABLE = 1 << 7;

class TimerChannel {
  /** Current 16-bit counter. */
  counter = 0;
  /** Reload value programmed via TMxCNT_L writes. */
  reload = 0;
  /** Current TMxCNT_H value. */
  control = 0;
  /** CPU cycles accumulated below the prescaler boundary. */
  prescalerSubticks = 0;
  /** Cycles remaining before the first counter increment after a 0→1
   *  enable transition. Real ARM7TDMI / GBA: the timer doesn't start
   *  ticking immediately — there's a 2-cycle gap between the bus
   *  write completing and the first counter increment landing. The
   *  mgba-suite timer tests probe this exact alignment via tight
   *  spin-loops that measure cycles-to-first-IRQ. */
  enableDelay = 0;
  /** Pending TMxCNT_L write that arrived while the timer was already
   *  enabled. Real ARM7TDMI / GBA: the bus data phase of an STR lands
   *  on the LAST cycle of the instruction, so a RELOAD write made
   *  during a 2-cycle STR doesn't take effect until 1 cycle has passed.
   *  If a counter overflow happens DURING that delay, the reload-on-
   *  overflow uses the OLD value, not the in-flight new one. Verified
   *  by nba-hw-test timer/reload's overwrite_*_7 cases. -1 means
   *  no pending write. */
  pendingReload = 0;
  pendingReloadCycles = -1;
  /** Pending TMxCNT_H write — same 1-cycle data-phase deferral as
   *  pendingReload. Most importantly: a STOP write (1→0 enable) made
   *  while the timer is running keeps the timer ticking through the
   *  STR's first cycle and only stops at the data phase. Verified by
   *  nba-hw-test timer/start-stop's 2ND probe (the difference
   *  between sample1=3 and sample2=8 is exactly that 1-cycle tail). */
  pendingControl = 0;
  pendingControlCycles = -1;

  constructor(readonly index: 0 | 1 | 2 | 3) {}

  get enabled(): boolean {
    return (this.control & CNT_ENABLE) !== 0;
  }
  /** Cascade ("count-up") only applies to timers 1-3. */
  get cascade(): boolean {
    return this.index !== 0 && (this.control & CNT_CASCADE) !== 0;
  }
  get irqOnOverflow(): boolean {
    return (this.control & CNT_IRQ) !== 0;
  }
  get prescaler(): number {
    return PRESCALERS[this.control & CNT_PRESCALER_MASK]!;
  }
}

export class Timer extends BaseIoHandler {
  readonly channels: readonly [TimerChannel, TimerChannel, TimerChannel, TimerChannel] = [
    new TimerChannel(0),
    new TimerChannel(1),
    new TimerChannel(2),
    new TimerChannel(3)
  ];

  constructor(
    private readonly interrupts: InterruptController,
    private readonly apu: Apu
  ) {
    super();
  }

  /** Advance every timer by `cycles` CPU cycles. Cascade timers
   *  aren't driven by the prescaler; they tick from the previous
   *  timer's overflow inside `overflow()`.
   *
   *  Real GBA: the per-channel prescaler is free-running — it counts
   *  cycles regardless of whether the timer is enabled, and the
   *  counter just samples its overflow events when enable is set.
   *  That alignment matters for mgba-suite's timer tests, which write
   *  the enable bit at arbitrary global cycles and measure when the
   *  next prescaler boundary lands. Resetting the subticks on every
   *  enable (the old behaviour) would always synthesise an aligned
   *  start, which doesn't match real silicon. */
  tick(cycles: number): void {
    for (const ch of this.channels) {
      // Inline of `ch.cascade` — this runs once per channel per CPU
      // instruction (millions of calls/sec); V8 wasn't inlining the
      // getter, costing ~4% of total runtime in profiles. Channel 0
      // never cascades; channels 1-3 skip the cycle-driven prescaler
      // path when the CNT_CASCADE bit is set in their control word
      // (cascade ticks only on the preceding timer's overflow). We
      // still process pending RELOAD / CONTROL writes for cascade
      // timers — otherwise a disable+re-enable sequence on a cascade
      // timer leaves it stuck in its prior state, because tick() never
      // gets to apply the deferred bits. SimCity 2000's audio mixer
      // relies on `write 0 then write new reload` to reset Timer 1's
      // counter; without applying the pending writes, the cart reads a
      // stale counter and ends up calling memset with a -2 count.
      const isCascade = ch.index !== 0 && (ch.control & CNT_CASCADE) !== 0;
      if (isCascade) {
        if (ch.pendingReloadCycles >= 0) {
          ch.reload = ch.pendingReload & 0xffff;
          ch.pendingReloadCycles = -1;
        }
        if (ch.pendingControlCycles >= 0) {
          this.applyControlWrite(ch, ch.pendingControl);
          ch.pendingControlCycles = -1;
        }
        continue;
      }
      // Pending RELOAD / CONTROL writes apply BETWEEN the second-to-last
      // cycle and the last cycle of this batch: real ARM7TDMI's STR data
      // phase lands on the LAST cycle of the instruction. So:
      //   - cycles 0..N-2: timer ticks with the OLD reload/control
      //   - bus write logically lands here (apply pending fields)
      //   - cycle N-1: timer ticks with the NEW reload/control
      // The CPU calls timer.tick(stepCycles) once per instruction, so
      // batch-size = instruction-cycle-count and the boundary is right.
      const hasPending = ch.pendingReloadCycles >= 0 || ch.pendingControlCycles >= 0;
      if (hasPending && cycles > 0) {
        this.tickCycles(ch, cycles - 1);
        // Apply pending RELOAD first so an enable transition triggered
        // by the CONTROL apply latches from the new reload value.
        if (ch.pendingReloadCycles >= 0) {
          ch.reload = ch.pendingReload & 0xffff;
          ch.pendingReloadCycles = -1;
        }
        if (ch.pendingControlCycles >= 0) {
          this.applyControlWrite(ch, ch.pendingControl);
          ch.pendingControlCycles = -1;
        }
        this.tickCycles(ch, 1);
      } else {
        this.tickCycles(ch, cycles | 0);
      }
    }
  }

  /** Apply a TMxCNT_H write to the channel, handling the 0→1 enable
   *  transition (latch reload into counter, arm enableDelay). Used by
   *  both the immediate path (write while disabled) and the deferred
   *  path (write while enabled, applied 1 cycle later). */
  private applyControlWrite(ch: TimerChannel, value: number): void {
    const wasEnabled = ch.enabled;
    ch.control = value & 0xffff;
    if (!wasEnabled && ch.enabled) {
      ch.counter = ch.reload & 0xffff;
      ch.enableDelay = 2;
    }
  }

  private tickCycles(ch: TimerChannel, cycles: number): void {
    if (cycles <= 0) return;
    // Disabled timer fast path: the prescaler is free-running but the
    // counter doesn't advance, so we only need the SUBTICKS-MOD-PRESCALER
    // result for whenever the timer gets re-enabled. Skip the per-cycle
    // loop entirely. This is the dominant case for typical workloads
    // (3 of 4 timers are usually disabled). Verified by the bench
    // suite — drops Timer.tick from 12% of frame time to ~2%.
    if (!ch.enabled) {
      const subticks = ch.prescalerSubticks + (cycles | 0);
      const prescaler = ch.prescaler;
      ch.prescalerSubticks = prescaler > 1 ? subticks % prescaler : 0;
      return;
    }
    let remaining = cycles | 0;
    // Burn the post-enable delay first — the prescaler is free-running
    // but the counter doesn't advance until enableDelay has been paid.
    if (ch.enableDelay > 0) {
      const consumed = remaining < ch.enableDelay ? remaining : ch.enableDelay;
      ch.enableDelay -= consumed;
      remaining -= consumed;
    }
    ch.prescalerSubticks += remaining;
    const prescaler = ch.prescaler;
    while (ch.prescalerSubticks >= prescaler) {
      ch.prescalerSubticks -= prescaler;
      this.advance(ch);
    }
  }

  /** Single-step a channel by one prescaler tick. Returns true on
   *  overflow. */
  private advance(ch: TimerChannel): boolean {
    ch.counter = (ch.counter + 1) & 0xffff;
    if (ch.counter === 0) {
      this.overflow(ch);
      return true;
    }
    return false;
  }

  private overflow(ch: TimerChannel): void {
    ch.counter = ch.reload & 0xffff;
    if (ch.irqOnOverflow) this.interrupts.raise(TIMER_IRQS[ch.index]!);
    // Drive Direct Sound FIFO pop: only timers 0/1 are wired to
    // sound on real hardware; APU.onTimerOverflow checks SOUNDCNT_H
    // to decide which (if any) FIFO is bound and emits a FIFO
    // request callback if the FIFO drops to half-empty.
    if (ch.index === 0) this.apu.onTimerOverflow(0);
    else if (ch.index === 1) this.apu.onTimerOverflow(1);
    // Cascade: tick the next timer once if it's enabled and in
    // cascade mode. Cascade chains are at most 4 deep on hardware.
    if (ch.index < 3) {
      const next = this.channels[ch.index + 1]!;
      if (next.enabled && next.cascade) this.advance(next);
    }
  }

  // ─── Bus I/O ────────────────────────────────────────────────────────

  read16(offset: number): number {
    const ch = this.channels[(offset / CH_SIZE) | 0];
    if (!ch) return 0;
    const within = (offset - ch.index * CH_SIZE) & ~1;
    if (within === TM_L) return ch.counter & 0xffff;
    if (within === TM_H) return ch.control & 0xffff;
    return 0;
  }

  write16(offset: number, value: number): void {
    const ch = this.channels[(offset / CH_SIZE) | 0];
    if (!ch) return;
    const within = (offset - ch.index * CH_SIZE) & ~1;
    const v = value & 0xffff;
    if (within === TM_L) {
      // Writes to TMxCNT_L update the reload value, not the live
      // counter — the latter loads on enable / overflow. While the
      // timer is disabled the write is immediate (the next 0→1 enable
      // will latch this value into the counter). While enabled, defer
      // by 1 cycle to model the STR data-phase landing at the LAST
      // cycle of the instruction — see TimerChannel.pendingReload.
      if (ch.enabled) {
        ch.pendingReload = v;
        ch.pendingReloadCycles = 1;
      } else {
        ch.reload = v;
      }
      return;
    }
    if (within === TM_H) {
      // Defer 1→0 disable transitions by 1 cycle so the timer ticks
      // through the STR's first cycle and only stops at the data phase
      // (nba-hw-test timer/start-stop's 2ND probe). Other TM_H
      // writes apply immediately: 0→1 enable transitions still latch
      // the reload here, and changes that keep the enable bit (e.g.,
      // prescaler / IRQ tweaks) match mgba-suite-timers' immediate
      // semantics. The 0→1 transition logic (counter ← reload, arm
      // enableDelay) lives in applyControlWrite, shared by both paths.
      const newEnabled = (v & CNT_ENABLE) !== 0;
      if (ch.enabled && !newEnabled) {
        ch.pendingControl = v;
        ch.pendingControlCycles = 1;
      } else {
        // Drop any stale pending — this new write supersedes it.
        ch.pendingControlCycles = -1;
        this.applyControlWrite(ch, v);
      }
      return;
    }
  }

  serialize(w: GbaStateWriter): void {
    for (const ch of this.channels) {
      w.u16(ch.counter);
      w.u16(ch.reload);
      w.u16(ch.control);
      w.u32(ch.prescalerSubticks);
      w.u16(ch.pendingReload);
      w.u32(ch.pendingReloadCycles + 1); // +1 so the -1 sentinel encodes as 0
      w.u32(ch.enableDelay);
      w.u16(ch.pendingControl);
      w.u32(ch.pendingControlCycles + 1);
    }
  }

  deserialize(r: GbaStateReader): void {
    for (const ch of this.channels) {
      ch.counter = r.u16();
      ch.reload = r.u16();
      ch.control = r.u16();
      ch.prescalerSubticks = r.u32();
      ch.pendingReload = r.u16();
      ch.pendingReloadCycles = r.u32() - 1;
      ch.enableDelay = r.u32();
      ch.pendingControl = r.u16();
      ch.pendingControlCycles = r.u32() - 1;
    }
  }
}
