/**
 * Standard NES controller button state.
 *
 * Host-agnostic: the browser shell calls `press`/`release` (the button names
 * match the Game Boy set, so the shared gamepad/keyboard binder works
 * unchanged), and the console reads {@link buttons} when the game strobes
 * $4016. The bitfield order matches the $4016 shift-out sequence.
 */

export type NesButton = "a" | "b" | "select" | "start" | "up" | "down" | "left" | "right";

const BIT: Record<NesButton, number> = {
  a: 0x01,
  b: 0x02,
  select: 0x04,
  start: 0x08,
  up: 0x10,
  down: 0x20,
  left: 0x40,
  right: 0x80
};

export class Joypad {
  /** Current button bitfield in $4016 shift order (A is bit 0). */
  buttons = 0;

  press(button: NesButton): void {
    this.buttons |= BIT[button];
  }
  release(button: NesButton): void {
    this.buttons &= ~BIT[button];
  }
  releaseAll(): void {
    this.buttons = 0;
  }
  /** Overwrite the whole bitfield (used by headless harnesses). */
  setState(state: number): void {
    this.buttons = state & 0xff;
  }
}
