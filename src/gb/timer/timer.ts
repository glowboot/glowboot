import { INTERRUPT_TIMER, type InterruptController } from "../memory/interrupts.js";
import type { StateReader, StateWriter } from "../serialization/serialization.js";

/**
 * Timer/Counter unit.
 *
 * Registers:
 *   0xFF04  DIV  – Divider (increments at 16384 Hz; write resets to 0)
 *   0xFF05  TIMA – Timer Counter (increments at frequency set by TAC)
 *   0xFF06  TMA  – Timer Modulo (value loaded into TIMA on overflow)
 *   0xFF07  TAC  – Timer Control
 *             Bit 2: Timer stop (0 = stop, 1 = run)
 *             Bit 1-0: Input clock select
 *               00 = 4096 Hz   (1024 M-cycles)
 *               01 = 262144 Hz (16 M-cycles)
 *               10 = 65536 Hz  (64 M-cycles)
 *               11 = 16384 Hz  (256 M-cycles)
 */

/** log2 of the TAC input-clock periods in T-cycles (1024, 16, 64, 256). */
const TAC_SHIFTS = [10, 4, 6, 8] as const;

export class Timer {
  /** Internal 16-bit DIV counter (upper byte exposed as 0xFF04). Post-boot
   *  value 0xABCC; cleared to 0 when a real boot ROM is running, since
   *  the boot ROM itself increments DIV and produces the post-boot value. */
  private div: number;
  private tima = 0x00;
  private tma = 0x00;
  private tac = 0xf8;

  /** TIMA reload state machine. After overflow, TIMA reads as 0 for one
   *  M-cycle, then "snaps to" TMA + IRQ on the following M-cycle. Mooneye
   *  exposes three quirks (`tima_reload`, `tima_write_reloading`,
   *  `tma_write_reloading`) that we model with three flags:
   *   - `reloadDelay`: 1 means "fire reload at start of next tick".
   *   - `overflowThisCycle`: a TIMA write in the overflow's own M-cycle
   *     succeeds AND cancels the pending reload.
   *   - `inReloadCycle`: the M-cycle where reload "happens" — TIMA reads
   *     return TMA, TIMA writes drop, TMA writes here are picked up by
   *     the commit at end of the cycle (start of next tick), so a same-
   *     cycle TMA write changes the reload value. */
  private reloadDelay = 0;
  private overflowThisCycle = false;
  private inReloadCycle = false;

  constructor(
    private readonly interrupts: InterruptController,
    preBoot = false
  ) {
    this.div = preBoot ? 0 : 0xabcc;
  }

  // ─── Bus interface ────────────────────────────────────────────────────────

  readByte(addr: number): number {
    switch (addr) {
      case 0xff04:
        return (this.div >> 8) & 0xff;
      case 0xff05:
        // During the reload M-cycle, the TIMA register reads as TMA even
        // before the actual `tima = tma` commit at end of cycle, since a
        // TMA write later in the same M-cycle still gets picked up.
        return this.inReloadCycle ? this.tma : this.tima;
      case 0xff06:
        return this.tma;
      case 0xff07:
        // Bits 3-7 of TAC are unused and read back as 1 (Mooneye
        // `unused_hwio-{GS,C}`). We only store the meaningful low 3 bits.
        return this.tac | 0xf8;
      default:
        return 0xff;
    }
  }

  /** TIMA input signal: AND of TAC's "selected bit" of div with TAC enable.
   *  Real hardware increments TIMA on this signal's *falling edge*, so any
   *  state change that drops the signal from 1 to 0 (DIV reset, TAC mode
   *  switch, TAC enable→disable) triggers an increment — even without a
   *  natural counter overflow. Mooneye's `tim*_div_trigger` and
   *  `rapid_toggle` exercise this exactly. */
  private timerInput(): boolean {
    if (!(this.tac & 0x04)) return false;
    return (this.div & (1 << (TAC_SHIFTS[this.tac & 0x03]! - 1))) !== 0;
  }

  private bumpTima(): void {
    this.tima = (this.tima + 1) & 0xff;
    if (this.tima === 0) {
      this.reloadDelay = 1;
      this.overflowThisCycle = true;
    }
  }

  writeByte(addr: number, value: number): void {
    const prevInput = this.timerInput();
    switch (addr) {
      case 0xff04:
        this.div = 0;
        break; // any write resets DIV
      case 0xff05:
        // TIMA writes interact with the reload state machine:
        //   - same M-cycle as the overflow (`overflowThisCycle`) → write
        //     succeeds AND cancels the pending reload.
        //   - inside the reload's M-cycle (`inReloadCycle`) → silently
        //     dropped; the latched TMA wins at end of cycle.
        if (this.inReloadCycle) {
          // dropped
        } else if (this.overflowThisCycle) {
          this.tima = value;
          this.reloadDelay = 0;
        } else {
          this.tima = value;
        }
        break;
      case 0xff06:
        this.tma = value;
        break;
      case 0xff07:
        this.tac = value & 0x07;
        break;
    }
    if (prevInput && !this.timerInput()) this.bumpTima();
  }

  // ─── Timing ───────────────────────────────────────────────────────────────

  /** Advance by `cycles` M-cycles. Iterates one M-cycle at a time so the
   *  reload-delay countdown stays aligned with bus accesses — the natural
   *  call site is `tick(1)` from CPU.busRead/busWrite, but `finishTicks`
   *  can pass a small batch of remaining cycles at end-of-instruction.
   *  Internal DIV is clocked at the 4.194 MHz T-cycle rate, so `div >> 8`
   *  (exposed as 0xFF04) advances every 256 T-cycles = 64 M-cycles, giving
   *  the documented 16384 Hz. */
  tick(cycles: number): void {
    for (let i = 0; i < cycles; i++) this.tickOneMcycle();
  }

  private tickOneMcycle(): void {
    // First: end any reload-cycle that's been running for one M-cycle.
    // We commit `tima = tma` here (not at fire time) so a TMA write made
    // during the reload's M-cycle still affects the reloaded value.
    if (this.inReloadCycle) {
      this.tima = this.tma;
      this.inReloadCycle = false;
    }

    this.overflowThisCycle = false;

    // Fire any pending reload at the start of this M-cycle. The reload's
    // M-cycle is THIS one (until the next tick commits it).
    if (this.reloadDelay > 0) {
      this.reloadDelay--;
      if (this.reloadDelay === 0) {
        this.inReloadCycle = true;
        this.interrupts.request(INTERRUPT_TIMER);
      }
    }

    const prevDiv = this.div;
    this.div = (prevDiv + 4) & 0xffff;

    if (!(this.tac & 0x04)) return; // timer stopped

    const shift = TAC_SHIFTS[this.tac & 0x03]!;
    if (prevDiv >>> shift !== this.div >>> shift) this.bumpTima();
  }

  serialize(w: StateWriter): void {
    w.u16(this.div);
    w.u8(this.tima);
    w.u8(this.tma);
    w.u8(this.tac);
    w.u8(this.reloadDelay);
  }
  deserialize(r: StateReader): void {
    this.div = r.u16();
    this.tima = r.u8();
    this.tma = r.u8();
    this.tac = r.u8();
    this.reloadDelay = r.u8();
    this.overflowThisCycle = false; // transient per-tick flag
    this.inReloadCycle = false; // reset on reload from save state
  }
}
