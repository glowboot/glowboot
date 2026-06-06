/**
 * GBA cart gyroscope — Analog Devices ADXRS300 single-axis Z-axis
 * rotation sensor, shipped in WarioWare: Twisted! (gamecodes
 * `RZWE` / `RZWP` / `RZWJ`). The chip measures angular velocity
 * around the screen-perpendicular axis (the player rotating the GBA
 * around its centre) and reports it as a 12-bit serial value over
 * the cart's GPIO bus.
 *
 * Protocol (per the published cart-GPIO reference and confirmed
 * empirically by the established open-source GBA emulators):
 *
 *   GPIO bit 0 (W): start conversion — rising edge latches a fresh
 *                   sample into the chip's shift register and primes
 *                   the data line with the first bit
 *   GPIO bit 1 (W): serial clock — the cart pulses this; on each
 *                   FALLING edge the chip shifts the next bit out
 *                   onto the data line
 *   GPIO bit 2 (R): serial data — the chip drives, the cart reads
 *   GPIO bit 3 (W): rumble — separate peripheral handled by
 *                   GpioRumble, not the gyroscope
 *
 * The cart shifts 16 bits MSB-first: 4 leading dummy zeros, then the
 * 12-bit ADC value. Per the cart-GPIO reference, the chip's "no
 * rotation" rest reading sits near 0x6C0, with clockwise rotation
 * pushing values above rest and anti-clockwise below — readings of
 * exactly 0x000 or 0xFFF would indicate "no sensor present" so our
 * encoding stays well clear of both extremes.
 *
 * Host-side angular-velocity source is in floating-point [-1, +1]:
 * +1 = full-clockwise rotation rate, -1 = full anti-clockwise, 0 =
 * stationary. Out-of-range values clamp.
 */

import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import type { GpioFeature } from "./gpio.js";
import type { GbaHeader } from "./header.js";

/** True for cart gamecodes that ship the ADXRS300 Z-axis gyroscope.
 *  WarioWare: Twisted! is the only retail cart with this peripheral. */
export function cartHasGyroscope(header: GbaHeader): boolean {
  return header.gameCode.startsWith("RZW");
}

/** GPIO pin layout — bits 0/1 are written by the cart, bit 2 is read,
 *  bit 3 is the rumble actuator on the same GPIO bank. */
const GYROSCOPE_SAMPLE_PIN = 1 << 0;
const GYROSCOPE_CLOCK_PIN = 1 << 1;
const GYROSCOPE_DATA_PIN = 1 << 2;

/** "No rotation" rest value the chip drives at idle, matching the
 *  encoding the established open-source GBA emulators use across the
 *  WarioWare Twisted mini-games. The published cart-trace example
 *  rest is ~0x6C0; 0x700 sits within the cart's accept-as-signal
 *  window and centres the 12-bit range. */
const GYROSCOPE_REST = 0x700;
/** Maximum 12-bit delta from rest per ±1.0 host-unit. Keeps the value
 *  inside `[0x300, 0xB00]` at full deflection — safely clear of the
 *  cart's `0x000`/`0xFFF` "no sensor" sentinels at both extremes. */
const GYROSCOPE_MAX_DELTA = 0x400;

/** Number of bits the chip shifts out per conversion. The cart reads
 *  16 bits but the high 4 are dummy zeros, leaving 12 bits of value. */
const GYROSCOPE_SHIFT_BITS = 16;

/** GPIO-feature implementation of the ADXRS300. The host wires
 *  `angularVelocitySource` to whatever input device represents
 *  Z-axis rotation (keyboard, DeviceMotion); the feature samples it
 *  on each cart-driven start-conversion pulse and shifts bits out
 *  on each cart-driven clock edge. */
export class GpioGyroscope implements GpioFeature {
  /** Polled by the chip on each start-conversion pulse to latch a
   *  fresh sample. Default returns 0 ("no rotation") so a cart that
   *  boots before the host has wired its rotation source still gets
   *  sensible readings. */
  angularVelocitySource: () => number = () => 0;

  /** 16-bit shift register the cart reads bit-by-bit. MSB is the
   *  next bit driven on the data pin. */
  private shiftRegister = 0;
  /** Previous frame's serial-clock state — used to detect the
   *  falling edge the chip shifts bits on. */
  private prevClockHigh = false;
  /** Current bit driven on GPIO data pin 2; updated by each clock
   *  edge or the start-conversion pulse. */
  private outputBit = 0;

  onDataWrite(cpuData: number, direction: number): void {
    // Bits the CPU is actually driving on the wire — match real
    // silicon: input-direction bits don't reach the chip.
    const driven = cpuData & direction;
    const startConversion = (driven & GYROSCOPE_SAMPLE_PIN) !== 0;
    const clockHigh = (driven & GYROSCOPE_CLOCK_PIN) !== 0;

    // Shift on each falling edge of the clock. The cart's loop is
    // "set clk-low, read data; set clk-high; repeat", so the
    // falling-edge timing means our shift happens just before the
    // cart's `ldrh` settles.
    let doShift = this.prevClockHigh && !clockHigh;

    if (startConversion) {
      const v = clamp(this.angularVelocitySource());
      const scaled = Math.round(v * GYROSCOPE_MAX_DELTA);
      // 12-bit value placed in the low half of a 16-bit shift register;
      // the high 4 bits are the dummy zeros the protocol expects.
      this.shiftRegister = (GYROSCOPE_REST + scaled) & 0x0fff;
      doShift = true;
    }

    if (doShift) {
      this.outputBit = (this.shiftRegister >>> (GYROSCOPE_SHIFT_BITS - 1)) & 1;
      this.shiftRegister = (this.shiftRegister << 1) & 0xffff;
    }

    this.prevClockHigh = clockHigh;
  }

  readData(direction: number): number {
    // Bit 2 is an input pin for the CPU — the chip drives it. If the
    // cart accidentally marks bit 2 as output (direction bit 2 = 1),
    // its own data wins and the chip's bit is masked off, matching
    // open-collector behaviour on real silicon.
    if ((direction & GYROSCOPE_DATA_PIN) !== 0) return 0;
    return this.outputBit << 2;
  }

  serialize(w: GbaStateWriter): void {
    w.u16(this.shiftRegister);
    w.bool(this.prevClockHigh);
    w.u8(this.outputBit);
  }

  deserialize(r: GbaStateReader): void {
    this.shiftRegister = r.u16();
    this.prevClockHigh = r.bool();
    this.outputBit = r.u8() & 1;
  }
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}
