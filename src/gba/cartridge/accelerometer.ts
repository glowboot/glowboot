/**
 * GBA cart accelerometer — Analog Devices ADXL202E 2-axis tilt sensor,
 * sitting in two of the retail GBA library's "special hardware" carts:
 *
 *   - Yoshi Topsy-Turvy   (USA `KYGE` / EUR `KYGP` / JPN `KYGJ`)
 *   - Koro Koro Puzzle    (Japan-only `KHPJ`, Konami 2003)
 *
 * Both carts share the same protocol. The sensor's address decoder is
 * wired to the GBA's 8-bit cart-SRAM bus at offset 0x8000-0x85FF within
 * the SRAM window (so physical addresses 0x0E008000-0x0E0085FF). The
 * cart talks to it byte-wide with LDRB / STRB:
 *
 *   Writes:
 *     0x0E008000  0x55              arm (latch the chip into "ready")
 *     0x0E008100  0xAA              trigger — chip samples X/Y and the
 *                                   four read slots hold the new value
 *
 *   Reads:
 *     0x0E008200  low byte of X     (bits 0-7 of the 12-bit value)
 *     0x0E008300  bits 8-11 of X + status (bit 7 = 1 once a sample has
 *                                   been latched — the cart spins on
 *                                   this as "ready")
 *     0x0E008400  low byte of Y
 *     0x0E008500  bits 8-11 of Y    (no status bit on this slot)
 *
 * Yoshi-family carts ship EEPROM at 0x0D000000 for save data, leaving
 * the SRAM bus free for the tilt sensor's decoder. Other carts have
 * SRAM or Flash on the same bus and wouldn't tolerate this overlay;
 * we gate the intercept on `cartHasTiltSensor(header)` so non-tilt
 * carts' SRAM/Flash accesses stay untouched.
 *
 * Encoding (12-bit) — the centres and full-deflection ranges below
 * come straight from the published cart-trace numbers ("X ranged
 * between 0x2AF and 0x477, center at 0x392; Y ranged between 0x2C3
 * and 0x480, center at 0x3A0"). The X centre is slightly off from
 * the Y centre on real silicon (chip mounting orientation on the
 * cart PCB), and Yoshi's calibration screens specifically reject
 * values outside the documented ranges — overshoot makes them
 * read as "no signal" and the cart stalls. The per-axis half-range
 * `RAW_HALF_RANGE` is the same magnitude on both axes within
 * rounding (0xE5 for X, 0xE0 for Y), so a single constant is fine.
 *
 * Note that the SRAM-region addresses overlap what would otherwise be
 * SRAM/Flash storage. The cart's PCB decoder activates the sensor in
 * response to specific accesses; outside the documented address slots
 * the bus reverts to the normal SRAM-region behaviour (open-bus 0xFF
 * for an EEPROM-backup cart). The `covers()` helper marks the active
 * slots — the bus uses it as the per-access gate.
 */

import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import type { GbaHeader } from "./header.js";

/** True for cart gamecodes that ship the ADXL202E accelerometer.
 *  Currently Yoshi Topsy-Turvy (KYG*) and Koro Koro Puzzle (KHPJ). */
export function cartHasTiltSensor(header: GbaHeader): boolean {
  const c = header.gameCode;
  return c.startsWith("KYG") || c === "KHPJ";
}

/** Mask that identifies the SRAM-region addresses the sensor claims.
 *  The cart bus delivers the low 16 bits of the SRAM-region address to
 *  the chip; only six values map to live slots (see file comment). */
export const TILT_ARM_ADDR = 0x0e008000;
export const TILT_TRIGGER_ADDR = 0x0e008100;
export const TILT_X_LOW_ADDR = 0x0e008200;
export const TILT_X_HIGH_ADDR = 0x0e008300;
export const TILT_Y_LOW_ADDR = 0x0e008400;
export const TILT_Y_HIGH_ADDR = 0x0e008500;

const ARM_VALUE = 0x55;
const TRIGGER_VALUE = 0xaa;

/** "GBA is level" centre on each axis. X and Y differ because of how
 *  the chip is mounted on the cart PCB (X centre rotated ~14 LSB from
 *  Y); using the same value for both is what causes the in-game
 *  rightward drift at idle. Per GBATEK published cart traces. */
const RAW_CENTRE_X = 0x392;
const RAW_CENTRE_Y = 0x3a0;
/** Magnitude of a full ±1g deflection in 12-bit LSB. The documented
 *  X range is 0x2AF..0x477 (half-range 0xE5) and Y is 0x2C3..0x480
 *  (half-range 0xE0); a single 0xE0 covers both within rounding and
 *  keeps the values inside Yoshi's "accept as signal" window. */
const RAW_HALF_RANGE = 0xe0;
const RAW_MIN = 0;
const RAW_MAX = 0xfff;
/** Status bit on the X high slot — bit 7 of the returned byte. The Y
 *  high slot does NOT carry this bit on real silicon. */
const STATUS_VALID = 0x80;

/** Power-on raw value — the chip's data lines float high before the
 *  first sample, so every bit reads 1. */
const RAW_INITIAL = 0xfff;

enum Phase {
  Idle = 0,
  Armed = 1
}

/** Live ADXL202E model. The host wires `tiltSource` to a polled
 *  `{x, y}` function (UI's `readTilt()` in practice); whenever the
 *  cart trigger-writes 0xAA, the sensor snapshots the source and
 *  encodes it into the 12-bit X/Y register pair the cart will read
 *  back through the four byte slots. */
export class TiltSensor {
  /** Polled when the cart triggers a sample. Defaults to a "perfectly
   *  level" reading so unit tests without a host wiring up the source
   *  see the neutral value. */
  tiltSource: () => { x: number; y: number } = () => ({ x: 0, y: 0 });

  /** Latched 12-bit X / Y values. */
  private rawX = RAW_INITIAL;
  private rawY = RAW_INITIAL;
  private phase = Phase.Idle;

  /** True if `addr` lies in the SRAM-region window this sensor claims.
   *  The bus uses this gate per byte access before delegating. */
  static covers(addr: number): boolean {
    return (
      addr === TILT_ARM_ADDR ||
      addr === TILT_TRIGGER_ADDR ||
      addr === TILT_X_LOW_ADDR ||
      addr === TILT_X_HIGH_ADDR ||
      addr === TILT_Y_LOW_ADDR ||
      addr === TILT_Y_HIGH_ADDR
    );
  }

  /** Byte read from one of the four data slots. Returns 0xFF for any
   *  other address inside the SRAM region (mirrors the chip's high-Z
   *  default and the open-bus 0xFF an EEPROM-backed cart returns).
   *
   *  The X-high slot's bit 7 is **always set** — it's how the cart
   *  probes "is the sensor present and responding?" before issuing
   *  the arm/trigger sequence. If we left it clear until after the
   *  first latch, the cart's presence-check would fail at boot and
   *  it'd enter a degenerate "no sensor" fallback that ignores the
   *  values we report. */
  read8(addr: number): number {
    switch (addr | 0) {
      case TILT_X_LOW_ADDR:
        return this.rawX & 0xff;
      case TILT_X_HIGH_ADDR:
        return ((this.rawX >>> 8) & 0xf) | STATUS_VALID;
      case TILT_Y_LOW_ADDR:
        return this.rawY & 0xff;
      case TILT_Y_HIGH_ADDR:
        return (this.rawY >>> 8) & 0xf;
      default:
        return 0xff;
    }
  }

  /** Byte write to the arm or trigger slots. Other addresses in the
   *  SRAM window are ignored — real silicon does the same. */
  write8(addr: number, value: number): void {
    switch (addr | 0) {
      case TILT_ARM_ADDR:
        if ((value & 0xff) === ARM_VALUE) {
          this.phase = Phase.Armed;
        }
        return;
      case TILT_TRIGGER_ADDR:
        if ((value & 0xff) === TRIGGER_VALUE && this.phase === Phase.Armed) {
          this.latch();
        }
        return;
      default:
        return;
    }
  }

  /** Capture the current host-side tilt vector and encode it. Public so
   *  unit tests can drive the chip without going through the bus. */
  latch(): void {
    const sample = this.tiltSource();
    this.rawX = encode(sample.x, RAW_CENTRE_X);
    this.rawY = encode(sample.y, RAW_CENTRE_Y);
    this.phase = Phase.Idle;
  }

  serialize(w: GbaStateWriter): void {
    w.u16(this.rawX);
    w.u16(this.rawY);
    w.u8(this.phase);
  }

  deserialize(r: GbaStateReader): void {
    this.rawX = r.u16();
    this.rawY = r.u16();
    this.phase = r.u8() === Phase.Armed ? Phase.Armed : Phase.Idle;
  }
}

function encode(gUnit: number, centre: number): number {
  // Yoshi's cart interprets above-centre raw values as "tilt right"
  // (X) or "tilt forward" (Y). Positive host-input means the player
  // wants Yoshi to roll in that direction, so we encode it as a
  // super-centre raw value the cart will translate to a rightward /
  // forward physics push.
  const v = Math.round(centre + gUnit * RAW_HALF_RANGE);
  if (v < RAW_MIN) return RAW_MIN;
  if (v > RAW_MAX) return RAW_MAX;
  return v;
}
