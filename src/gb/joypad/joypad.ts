import { INTERRUPT_JOYPAD, type InterruptController } from "../memory/interrupts.js";
import type { StateReader, StateWriter } from "../serialization/serialization.js";

/**
 * Joypad controller — register 0xFF00.
 *
 * Bit 5: Select action  buttons (0 = select)
 * Bit 4: Select direction buttons (0 = select)
 * Bit 3: Down  / Start
 * Bit 2: Up    / Select
 * Bit 1: Left  / B
 * Bit 0: Right / A
 *
 * Bits 0–3 are active-low: 0 means pressed.
 */

export type Button = "right" | "left" | "up" | "down" | "a" | "b" | "select" | "start";

const DIRECTION_MASK = 0x10;
const ACTION_MASK = 0x20;

export class Joypad {
  /** Currently pressed buttons */
  private buttons: Set<Button> = new Set();
  private select = 0xff; // last written to 0xFF00

  constructor(private readonly interrupts: InterruptController) {}

  // ─── Bus interface ────────────────────────────────────────────────────────

  read(): number {
    let lo = 0x0f; // all released

    const selectAction = !(this.select & ACTION_MASK);
    const selectDirection = !(this.select & DIRECTION_MASK);

    if (selectAction) {
      if (this.buttons.has("a")) lo &= ~0x01;
      if (this.buttons.has("b")) lo &= ~0x02;
      if (this.buttons.has("select")) lo &= ~0x04;
      if (this.buttons.has("start")) lo &= ~0x08;
    }
    if (selectDirection) {
      if (this.buttons.has("right")) lo &= ~0x01;
      if (this.buttons.has("left")) lo &= ~0x02;
      if (this.buttons.has("up")) lo &= ~0x04;
      if (this.buttons.has("down")) lo &= ~0x08;
    }

    return (this.select & 0x30) | lo | 0xc0;
  }

  write(value: number): void {
    this.select = value & 0x30;
  }

  // ─── Input interface ──────────────────────────────────────────────────────

  press(button: Button): void {
    if (!this.buttons.has(button)) {
      this.buttons.add(button);
      this.interrupts.request(INTERRUPT_JOYPAD);
    }
  }

  release(button: Button): void {
    this.buttons.delete(button);
  }

  serialize(w: StateWriter): void {
    w.u8(this.select);
  }
  deserialize(r: StateReader): void {
    this.select = r.u8();
  }
}
