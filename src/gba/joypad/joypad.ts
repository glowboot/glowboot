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
 * When bit 14 is set and the selected-key condition becomes true, the
 * joypad raises IRQ_KEYPAD (on the rising edge). AND with an empty mask
 * is vacuously true — how unattended self-tests (the AGB aging cartridge)
 * fire the keypad IRQ without a key press.
 *
 * UI integration: `gamepad.press(b)` / `gamepad.release(b)` accept
 * the same lowercase button names the GB joypad uses (`a`, `b`,
 * `select`, `start`, `up`, `down`, `left`, `right`) plus `l` and `r`
 * for the GBA shoulders.
 */

import { type InterruptController, IRQ_KEYPAD } from "../memory/interrupts.js";
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

  /** Last-written KEYCNT value. */
  private keycnt = 0;

  /** Interrupt controller — the joypad raises IRQ_KEYPAD when KEYCNT's
   *  key-match condition becomes true and bit 14 (IRQ enable) is set.
   *  Wired by the Gba constructor. */
  interrupts: InterruptController | null = null;

  /** Edge-detect latch for the keypad-match condition. The IRQ fires on
   *  the false→true transition (re-evaluated on every key change and
   *  KEYCNT write) so a continuously-true condition doesn't re-flood IF
   *  after the handler acknowledges it. Transient — not serialized. */
  private keypadMatched = false;

  press(button: GbaButton): void {
    this.held |= 1 << BIT[button];
    this.checkKeypadIrq();
  }

  release(button: GbaButton): void {
    this.held &= ~(1 << BIT[button]);
    this.checkKeypadIrq();
  }

  /** Release every button. Called by the host on blur / tab-switch so a
   *  key whose `keyup` never arrived can't leave a button stuck down. */
  releaseAll(): void {
    this.held = 0;
    this.checkKeypadIrq();
  }

  /** Raise IRQ_KEYPAD on the rising edge of the KEYCNT key-match
   *  condition. Selected keys are KEYCNT bits 0-9; a key counts as
   *  pressed when held. Bit 15 picks AND (all selected) vs OR (any
   *  selected) — note AND with an empty mask is vacuously true, which is
   *  how unattended self-tests (the AGB aging cartridge) trigger it. */
  private checkKeypadIrq(): void {
    let matched = false;
    if ((this.keycnt & 0x4000) !== 0) {
      const selected = this.keycnt & 0x03ff;
      const pressed = this.held & 0x03ff;
      matched = (this.keycnt & 0x8000) !== 0 ? (selected & pressed) === selected : (selected & pressed) !== 0;
    }
    if (matched && !this.keypadMatched) this.interrupts?.raise(IRQ_KEYPAD);
    this.keypadMatched = matched;
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
    this.checkKeypadIrq();
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
