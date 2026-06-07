/**
 * GBA joypad controller — KEYINPUT (read-only) + KEYCNT (R/W).
 *
 * KEYINPUT (0x04000130, 16-bit, read-only):
 *   bit 0 = A, 1 = B, 2 = SELECT, 3 = START,
 *   bit 4 = RIGHT, 5 = LEFT, 6 = UP, 7 = DOWN,
 *   bit 8 = R (right shoulder), 9 = L (left shoulder),
 *   bits 10-15 = unused (read as 0 on hardware).
 * Each bit is active-low: 0 means held, 1 means released.
 *
 * KEYCNT (0x04000132, 16-bit, R/W):
 *   bit 0-9 mirror the KEYINPUT bit assignment and select which keys
 *   contribute to the IRQ.
 *   bit 14 = IRQ enable.
 *   bit 15 = IRQ condition (0 = OR / any selected key, 1 = AND / all).
 * Stored verbatim here; IRQ delivery isn't wired yet so writing
 * doesn't fire anything. Real games still write KEYCNT for the
 * future IRQ hookup, and we round-trip the bits.
 *
 * UI integration: `gamepad.press(b)` / `gamepad.release(b)` accept
 * the same lowercase button names the GB joypad uses (`a`, `b`,
 * `select`, `start`, `up`, `down`, `left`, `right`) plus `l` and `r`
 * for the GBA shoulders.
 */

import { BaseIoHandler } from "../memory/io-handler-base.js";
import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";

export type GbaButton = "a" | "b" | "select" | "start" | "right" | "left" | "up" | "down" | "r" | "l";

const BIT: Record<GbaButton, number> = {
  a: 0,
  b: 1,
  select: 2,
  start: 3,
  right: 4,
  left: 5,
  up: 6,
  down: 7,
  r: 8,
  l: 9
};

const KEYINPUT_OFFSET = 0x00;
const KEYCNT_OFFSET = 0x02;

export class Joypad extends BaseIoHandler {
  /** Bitmask of currently-held buttons (1 bit per button in
   *  KEYINPUT-bit position). Stored as held=1 internally so we
   *  produce KEYINPUT by inverting and OR-ing the reserved-high bits. */
  private held = 0;

  /** Last-written KEYCNT value. No IRQ wiring yet. */
  private keycnt = 0;

  press(button: GbaButton): void {
    this.held |= 1 << BIT[button];
  }

  release(button: GbaButton): void {
    this.held &= ~(1 << BIT[button]);
  }

  /** Release every button. Called by the host on blur / tab-switch so a
   *  key whose `keyup` never arrived can't leave a button stuck down. */
  releaseAll(): void {
    this.held = 0;
  }

  isPressed(button: GbaButton): boolean {
    return (this.held & (1 << BIT[button])) !== 0;
  }

  /** Compute KEYINPUT's current value (active-low for the 10 button
   *  bits 0-9; the unused bits 10-15 read as 0 on hardware). Tests use
   *  this; the bus reads through `read16`. */
  keyinput(): number {
    return ~this.held & 0x03ff;
  }

  read16(offset: number): number {
    const aligned = offset & ~1;
    if (aligned === KEYINPUT_OFFSET) return this.keyinput();
    if (aligned === KEYCNT_OFFSET) return this.keycnt & 0xffff;
    return 0;
  }

  write16(offset: number, value: number): void {
    const aligned = offset & ~1;
    if (aligned !== KEYCNT_OFFSET) return; // KEYINPUT is read-only
    this.keycnt = value & 0xffff;
  }

  serialize(w: GbaStateWriter): void {
    w.u16(this.held);
    w.u16(this.keycnt);
  }

  deserialize(r: GbaStateReader): void {
    r.u16(); // held — read to advance, but discarded: live input isn't part
    this.held = 0; //        of a restored game (you're not holding anything).
    this.keycnt = r.u16();
  }
}
