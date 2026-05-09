/**
 * Interrupt flags (IF at 0xFF0F, IE at 0xFFFF).
 *
 * Bit 0 – VBlank
 * Bit 1 – LCD STAT
 * Bit 2 – Timer
 * Bit 3 – Serial
 * Bit 4 – Joypad
 */
import type { StateReader, StateWriter } from "../serialization/serialization.js";

export const INTERRUPT_VBLANK = 0x01;
export const INTERRUPT_LCD = 0x02;
export const INTERRUPT_TIMER = 0x04;
export const INTERRUPT_SERIAL = 0x08;
export const INTERRUPT_JOYPAD = 0x10;

/** Jump vectors for each interrupt source. */
export const INTERRUPT_VECTORS: Record<number, number> = {
  [INTERRUPT_VBLANK]: 0x0040,
  [INTERRUPT_LCD]: 0x0048,
  [INTERRUPT_TIMER]: 0x0050,
  [INTERRUPT_SERIAL]: 0x0058,
  [INTERRUPT_JOYPAD]: 0x0060
};

export class InterruptController {
  /** Interrupt Enable register (0xFFFF) */
  ie = 0x00;
  /** Interrupt Flag register (0xFF0F) */
  if = 0x00;

  /** Request an interrupt by OR-ing its bit into IF. */
  request(flag: number): void {
    this.if |= flag;
  }

  /**
   * Returns the highest-priority pending interrupt flag,
   * or 0 if none are both enabled and requested.
   */
  pending(): number {
    const active = this.ie & this.if & 0x1f;
    if (active === 0) return 0;
    // Lowest bit = highest priority
    return active & -active;
  }

  /** Acknowledge (clear) a serviced interrupt. */
  acknowledge(flag: number): void {
    this.if &= ~flag;
  }

  serialize(w: StateWriter): void {
    w.u8(this.ie);
    w.u8(this.if);
  }
  deserialize(r: StateReader): void {
    this.ie = r.u8();
    this.if = r.u8();
  }
}
