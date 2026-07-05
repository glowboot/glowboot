/**
 * SNES controller 1 state, in the $4218/$4219 (JOY1L/JOY1H) bit order the
 * auto-joypad read and the $4016 serial shift both report:
 *
 *   bit 15..8  B  Y  Select  Start  Up  Down  Left  Right
 *   bit  7..4  A  X  L  R
 *
 * Host-agnostic: the browser shell calls `press`/`release` with button
 * names; headless scripts may drive the raw mask directly via `setRaw`.
 */

export type SnesButton = "a" | "b" | "x" | "y" | "l" | "r" | "select" | "start" | "up" | "down" | "left" | "right";

const BIT: Record<SnesButton, number> = {
  b: 0x8000,
  y: 0x4000,
  select: 0x2000,
  start: 0x1000,
  up: 0x0800,
  down: 0x0400,
  left: 0x0200,
  right: 0x0100,
  a: 0x0080,
  x: 0x0040,
  l: 0x0020,
  r: 0x0010
};

export class SnesJoypad {
  private pressed = 0;
  private raw = 0;

  /** The JOY1 mask the console latches. */
  get buttons(): number {
    return this.pressed | this.raw;
  }

  press(button: SnesButton): void {
    this.pressed |= BIT[button] ?? 0;
  }

  release(button: SnesButton): void {
    this.pressed &= ~(BIT[button] ?? 0);
  }

  releaseAll(): void {
    this.pressed = 0;
  }

  /** Direct mask overlay for headless drivers (tests, sweeps). */
  setRaw(mask: number): void {
    this.raw = mask & 0xffff;
  }
}
