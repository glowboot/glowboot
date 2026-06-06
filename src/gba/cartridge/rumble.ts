/**
 * GBA cart rumble — actuator wired to GPIO bit 3, modelled as a
 * GpioFeature so it shares the cart GPIO bus with other peripherals
 * (an RTC chip or gyroscope can sit on the same port concurrently).
 *
 * Detection covers the two retail carts that ship a GPIO-bit-3
 * rumble motor:
 *   - Drill Dozer        (`V49E` USA / `V49P` Europe / `V49J` Japan /
 *                         `V49K` Korea) — rumble only
 *   - WarioWare: Twisted (`RZWE` / `RZWP` / `RZWJ`) — rumble + gyroscope
 *
 * Pokémon Pinball variants wire rumble differently and are not
 * matched. Pokémon Gen 3 / Boktai share the same GPIO bank but for
 * the RTC chip, not rumble — the gamecode gate keeps those carts off
 * the rumble actuator.
 *
 * Pin mapping: rumble actuator is GPIO data-register bit 3. Writing a
 * 1 to bit 3 spins the motor; writing 0 stops it. The cart's
 * direction register must mark bit 3 as output (the CPU driving the
 * pin) for the write to mean anything — input-direction writes don't
 * reach the actuator on real silicon, and the feature mirrors that.
 */

import { GPIO_BIT3, type GpioFeature } from "./gpio.js";
import type { GbaHeader } from "./header.js";

/** True for cart gamecodes that signal a GPIO-driven rumble motor on
 *  data-bit 3. Currently Drill Dozer (V49*) and WarioWare Twisted
 *  (RZW*); both wire the actuator the same way despite carrying very
 *  different "main" peripherals on the rest of the GPIO pins. */
export function cartHasGpioRumble(header: GbaHeader): boolean {
  const c = header.gameCode;
  return c.startsWith("V49") || c.startsWith("RZW");
}

/** GPIO-feature implementation of the rumble actuator. Constructed by
 *  the Gba host with a callback that forwards bit-3 toggles to the UI
 *  (gamepad.setRumble / safeVibrate). */
export class GpioRumble implements GpioFeature {
  private wasOn = false;

  constructor(private readonly onChange: (on: boolean) => void) {}

  onDataWrite(cpuData: number, direction: number): void {
    // The actuator only spins when the CPU is driving bit 3 (direction
    // bit set). Without the mask we'd false-positive on the input
    // path where the data-register read-back tracks whatever the cart
    // last drove on input pins.
    if ((direction & GPIO_BIT3) === 0) return;
    const on = (cpuData & GPIO_BIT3) !== 0;
    if (on !== this.wasOn) {
      this.wasOn = on;
      this.onChange(on);
    }
  }

  readData(_direction: number): number {
    return 0;
  }
}
