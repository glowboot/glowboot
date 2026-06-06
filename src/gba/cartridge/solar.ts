/**
 * GBA cart solar sensor — photodiode + 8-bit digital-ramp ADC, shipped
 * in the Boktai trilogy (sunlight powers your weapons against vampires):
 *
 *   - Boktai: The Sun Is in Your Hand     (`U3IE` / `U3IJ` / `U3IP`)
 *   - Boktai 2: Solar Boy Django           (`U32E` / `U32J` / `U32P`)
 *   - Shin Bokura no Taiyō (Boktai 3, JP)  (`U33J`)
 *
 * The cart contains a photodiode looking out through a transparent
 * window on the cart shell, a 74LV4040 12-bit binary counter (the
 * low 8 bits routed to the bus), and a TLV272 voltage comparator.
 * The cart's CPU clocks the counter via GPIO, and the comparator
 * flips its output bit when the counter's voltage equals the
 * photodiode's. The CPU then knows the ambient brightness from how
 * many clock pulses it took.
 *
 *   GPIO bit 0 (W): clock — rising edge increments the on-chip counter
 *   GPIO bit 1 (W): reset — high resets counter to 0 AND samples the
 *                   photodiode (the in-cart counter restart and ADC
 *                   sample are wired together)
 *   GPIO bit 2 (W): chip-select — high suppresses processing of the
 *                   reset / clock pins for that write. We don't gate
 *                   the bit-3 readback on this — Boktai keeps chip-
 *                   select asserted across its measurement loop, and
 *                   a fully accurate "output high-Z on disable" would
 *                   need extra state we don't carry.
 *   GPIO bit 3 (R): comparator output — high once `counter ≥ sample`
 *
 * `lightSample` is the 8-bit photodiode reading: `0x00` = blindingly
 * bright, `0xFF` = pitch black. The cart counts clock pulses until
 * the comparator flips, so a brighter day produces a smaller counter
 * value when the cart's loop exits. Published cart traces give:
 *
 *   0xE8 — total darkness (indoor LED only)
 *   0xD0 — close to a 100 W bulb
 *   0x50 — full solar gauge in Boktai's HUD
 *   0x00 — directly under the sun (or your city is being nuked)
 *
 * `lightSample` defaults to 0xFF on power-on so a cart loaded without
 * a wired host source spawns into "darkness" and the player can step
 * into the calibration menu (Boktai's Options → cover the sensor)
 * before adjusting their luminance source.
 *
 * The host-side luminance source returns brightness in `[0, 1]`:
 * 0 = total darkness, 1 = full sun. The slider is quantised to 11
 * positions (level 0..10, in increments of 0.1) and mapped through
 * an exponential lux curve that matches the photodiode's logarithmic
 * response — see `encodeSample` below — so the in-game gauge advances
 * roughly one bar per slider step. A linear `(1-brightness) * 0xFF`
 * mapping looks sensible on paper but doesn't line up with the cart's
 * HUD: slider 10 % would show ~3 bars instead of the 1 bar the player
 * expects.
 */

import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import type { GpioFeature } from "./gpio.js";
import type { GbaHeader } from "./header.js";

/** True for cart gamecodes that ship the Konami solar sensor: the
 *  three Boktai games (Worldwide releases plus the Japan-only third
 *  entry). */
export function cartHasSolarSensor(header: GbaHeader): boolean {
  const c = header.gameCode;
  return c.startsWith("U3I") || c.startsWith("U32") || c.startsWith("U33");
}

const SOLAR_CLOCK_PIN = 1 << 0;
const SOLAR_RESET_PIN = 1 << 1;
const SOLAR_DISABLE_PIN = 1 << 2;
const SOLAR_OUT_PIN = 1 << 3;

/** Power-on sample — total darkness. A cart booted before the host
 *  has wired a luminance source still gets a sensible "no light"
 *  reading and won't break its calibration loop. */
const SAMPLE_DARK = 0xff;

/** GPIO-feature implementation of Boktai's photodiode + counter ADC.
 *  The host wires `brightnessSource` to whatever input device
 *  represents ambient light (keyboard, slider, DeviceLight on phones);
 *  the feature samples it on each cart-driven counter reset. */
export class GpioSolarSensor implements GpioFeature {
  /** Polled by the chip on each counter-reset pulse to latch a fresh
   *  photodiode reading. Brightness is `[0, 1]`; default returns
   *  total darkness so an unwired host still produces a stable
   *  cart-side calibration loop. */
  brightnessSource: () => number = () => 0;

  /** Internal 8-bit counter incremented by each clock-pin rising
   *  edge. Wraps at 0x100 — beyond that the cart's loop is expected
   *  to give up and treat the cart as "no sensor". */
  private counter = 0;
  /** Latched photodiode reading at the most recent counter reset. */
  private lightSample = SAMPLE_DARK;
  /** Previous clock-pin state, used to detect the rising edge the
   *  counter increments on. Stored as "edge = last clock was low",
   *  so the next high reading constitutes a rising edge. */
  private clockWasLow = true;

  onDataWrite(cpuData: number, direction: number): void {
    const driven = cpuData & direction;
    // Chip-select pin high = chip disabled (output pin reverts to
    // whatever the cart's pull-up sets, which is typically high).
    if ((driven & SOLAR_DISABLE_PIN) !== 0) return;

    if ((driven & SOLAR_RESET_PIN) !== 0) {
      this.counter = 0;
      this.clockWasLow = true;
      this.lightSample = encodeSample(this.brightnessSource());
    }

    const clockHigh = (driven & SOLAR_CLOCK_PIN) !== 0;
    if (clockHigh && this.clockWasLow) {
      this.counter = (this.counter + 1) & 0xff;
    }
    this.clockWasLow = !clockHigh;
  }

  readData(direction: number): number {
    // Bit 3 is the chip's comparator output. The cart marks bit 3 as
    // input (direction bit 3 = 0); if it accidentally marks bit 3
    // as output the chip stays off the wire — open-collector wins
    // and we return 0 like the other GPIO features.
    if ((direction & SOLAR_OUT_PIN) !== 0) return 0;
    return this.counter >= this.lightSample ? SOLAR_OUT_PIN : 0;
  }

  serialize(w: GbaStateWriter): void {
    w.u8(this.counter);
    w.u8(this.lightSample);
    w.bool(this.clockWasLow);
  }

  deserialize(r: GbaStateReader): void {
    this.counter = r.u8();
    this.lightSample = r.u8();
    this.clockWasLow = r.bool();
  }
}

/** Photodiode-response base offset. Level 0 sits at this lux value —
 *  just past the "total darkness" threshold (`0xE8`) the calibration
 *  trace observed — so a fresh cart still satisfies its dark-side
 *  calibration loop. */
const LUX_BASE = 0x16;

/** Per-step lux growth factor. Picked so `LUX_BASE + LUX_AMP *
 *  (LUX_GROWTH ^ 10 − 1) ≈ 205` (level 10), matching the published
 *  "full HUD gauge" calibration point. The value is ~1.275 — close
 *  to 5⁴√3 — and the curve hugs the photodiode's log response with
 *  ≤ 5-byte deviation from a pure empirical fit, well inside the
 *  ~15-byte span each in-game gauge bar occupies. */
const LUX_GROWTH = 1.275;
const LUX_AMP = 17.82;

function encodeSample(brightness: number): number {
  if (!Number.isFinite(brightness)) return SAMPLE_DARK;
  const clamped = brightness <= 0 ? 0 : brightness >= 1 ? 1 : brightness;
  const level = Math.round(clamped * 10);
  // delta(k) = LUX_AMP · (LUX_GROWTH^k − 1) — the exponential form
  // matches the photodiode's logarithmic response, so equal slider
  // steps produce roughly equal perceived brightness steps and the
  // in-game gauge advances ~one bar per step.
  const lux = LUX_BASE + Math.round(LUX_AMP * (Math.pow(LUX_GROWTH, level) - 1));
  return (0xff - lux) & 0xff;
}
