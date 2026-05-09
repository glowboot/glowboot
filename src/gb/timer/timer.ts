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
  /** Internal 16-bit DIV counter (upper byte exposed as 0xFF04) */
  private div = 0xabcc; // post-boot value
  private tima = 0x00;
  private tma = 0x00;
  private tac = 0xf8;

  constructor(private readonly interrupts: InterruptController) {}

  // ─── Bus interface ────────────────────────────────────────────────────────

  readByte(addr: number): number {
    switch (addr) {
      case 0xff04:
        return (this.div >> 8) & 0xff;
      case 0xff05:
        return this.tima;
      case 0xff06:
        return this.tma;
      case 0xff07:
        return this.tac;
      default:
        return 0xff;
    }
  }

  writeByte(addr: number, value: number): void {
    switch (addr) {
      case 0xff04:
        this.div = 0;
        break; // any write resets DIV
      case 0xff05:
        this.tima = value;
        break;
      case 0xff06:
        this.tma = value;
        break;
      case 0xff07:
        this.tac = value & 0x07;
        break;
    }
  }

  // ─── Timing ───────────────────────────────────────────────────────────────

  /** Advance by `cycles` M-cycles in bulk. */
  tick(cycles: number): void {
    // Internal DIV is clocked at the 4.194 MHz T-cycle rate, so `div >> 8`
    // (exposed as 0xFF04) advances every 256 T-cycles = 64 M-cycles, giving
    // the documented 16384 Hz. TAC's shifts are likewise T-cycle powers
    // (1024 / 16 / 64 / 256 T-cycles for 4096 / 262144 / 65536 / 16384 Hz).
    const t = cycles * 4; // M-cycles → T-cycles
    const prevDiv = this.div;
    const rawDiv = prevDiv + t;
    this.div = rawDiv & 0xffff;

    if (!(this.tac & 0x04)) return; // timer stopped

    // Each TIMA input is a power-of-two threshold, so boundary crossings in
    // (prevDiv, rawDiv] equal the difference of shifted counters.
    const shift = TAC_SHIFTS[this.tac & 0x03]!;
    let ticks = (rawDiv >>> shift) - (prevDiv >>> shift);

    while (ticks-- > 0) {
      this.tima++;
      if (this.tima > 0xff) {
        this.tima = this.tma;
        this.interrupts.request(INTERRUPT_TIMER);
      }
    }
  }

  serialize(w: StateWriter): void {
    w.u16(this.div);
    w.u8(this.tima);
    w.u8(this.tma);
    w.u8(this.tac);
  }
  deserialize(r: StateReader): void {
    this.div = r.u16();
    this.tima = r.u8();
    this.tma = r.u8();
    this.tac = r.u8();
  }
}
