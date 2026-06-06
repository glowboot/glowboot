import { describe, expect, it } from "vitest";

import { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import type { GbaHeader } from "./header.js";
import { cartHasSolarSensor, GpioSolarSensor } from "./solar.js";

function header(gameCode: string): GbaHeader {
  return {
    title: "TEST",
    gameCode,
    makerCode: "01",
    version: 0,
    headerChecksum: 0,
    headerChecksumValid: true
  };
}

function makeSensor(source: () => number): GpioSolarSensor {
  const s = new GpioSolarSensor();
  s.brightnessSource = source;
  return s;
}

const CLOCK = 1 << 0;
const RESET = 1 << 1;
const DISABLE = 1 << 2;
const OUT = 1 << 3;
const ALL_OUTPUT = CLOCK | RESET | DISABLE;
const INPUT_DIR_FOR_OUT = ALL_OUTPUT; // direction = 0x7: bits 0/1/2 out, bit 3 in

describe("cartHasSolarSensor", () => {
  it.each([
    ["U3IE", true], // Boktai 1 USA
    ["U3IJ", true], // Boktai 1 JP
    ["U3IP", true], // Boktai 1 EU
    ["U32E", true], // Boktai 2 Solar Boy Django USA
    ["U32J", true],
    ["U32P", true],
    ["U33J", true], // Boktai 3 (Japan-only)
    ["V49E", false], // Drill Dozer
    ["RZWE", false], // WarioWare Twisted
    ["KYGE", false], // Yoshi tilt
    ["BPEE", false], // Pokémon Emerald (RTC, not solar)
    ["AGBE", false]
  ])("%s → %s", (code, expected) => {
    expect(cartHasSolarSensor(header(code))).toBe(expected);
  });
});

/** Run the cart's count-until-bit-3-high loop with the given brightness
 *  source and return the counter value at which the comparator flipped
 *  (or 0x100 if it never flipped). Mirrors the inner loop of Boktai's
 *  `solar_read` routine. */
function rampCounter(sensor: GpioSolarSensor): number {
  // Reset pulse: bit 1 high → samples brightness + resets counter.
  sensor.onDataWrite(RESET, INPUT_DIR_FOR_OUT);
  sensor.onDataWrite(0, INPUT_DIR_FOR_OUT);

  for (let i = 0; i < 256; i++) {
    // Clock high — rising edge increments counter.
    sensor.onDataWrite(CLOCK, INPUT_DIR_FOR_OUT);
    // Clock low.
    sensor.onDataWrite(0, INPUT_DIR_FOR_OUT);
    // Read bit 3.
    if ((sensor.readData(INPUT_DIR_FOR_OUT) & OUT) !== 0) {
      return i + 1; // counter incremented before this read
    }
  }
  return 0x100; // timeout — chip absent or already-counter-saturated
}

describe("GpioSolarSensor", () => {
  // Expected counter values come from the lux-curve formula in
  // solar.ts (`encodeSample`). Slider brightness 0..1 quantises to
  // level 0..10 (every 0.1); each level maps to a photo byte
  // calibrated so the in-game gauge advances ~one bar per step.
  it("counts to 0xE9 (level 0 'total darkness') at brightness 0", () => {
    const sensor = makeSensor(() => 0);
    expect(rampCounter(sensor)).toBe(0xe9);
  });

  it("counts to 0x31 (level 10 'full HUD gauge / direct sun') at brightness 1", () => {
    const sensor = makeSensor(() => 1);
    expect(rampCounter(sensor)).toBe(0x31);
  });

  it("counts to level 5 (0xBF) at medium brightness 0.5", () => {
    const sensor = makeSensor(() => 0.5);
    expect(rampCounter(sensor)).toBe(0xbf);
  });

  it("brighter input lands at a lower counter value", () => {
    const dim = makeSensor(() => 0.2);
    const bright = makeSensor(() => 0.8);
    expect(rampCounter(bright)).toBeLessThan(rampCounter(dim));
  });

  it("clamps brightness inputs outside [0, 1]", () => {
    const tooBright = makeSensor(() => 5);
    const tooDark = makeSensor(() => -2);
    const nan = makeSensor(() => NaN);
    // tooBright clamps to 1 → level 10 → 0x31
    expect(rampCounter(tooBright)).toBe(0x31);
    // tooDark clamps to 0 → level 0 → 0xE9
    expect(rampCounter(tooDark)).toBe(0xe9);
    // NaN → SAMPLE_DARK = 0xFF (formula skipped; guards against a
    // silently-broken host source rather than picking a level).
    expect(rampCounter(nan)).toBe(0xff);
  });

  it("returns 0 on bit-3 reads when chip-select pin is high (chip disabled)", () => {
    // With bit 2 high, onDataWrite returns early and the chip's bit-3
    // output stays at whatever it was previously. Power-on counter=0
    // < lightSample=0xFF → bit 3 reads 0.
    const sensor = makeSensor(() => 0.5);
    sensor.onDataWrite(DISABLE | RESET, INPUT_DIR_FOR_OUT); // disable wins, reset NOT applied
    sensor.onDataWrite(DISABLE, INPUT_DIR_FOR_OUT);
    // counter is still 0, lightSample is still default (0xFF from
    // power-on); 0 < 0xFF → bit 3 read returns 0.
    expect(sensor.readData(INPUT_DIR_FOR_OUT) & OUT).toBe(0);
  });

  it("re-samples brightness on every reset pulse, not once at boot", () => {
    // Cart calibrates by reading darkness first, then brightness.
    // Each reset pulse should give the cart the current ambient
    // value, not a stale one — otherwise Boktai's auto-calibration
    // would lock to whatever brightness was present at cart-load.
    let phase = 0;
    const sensor = makeSensor(() => (phase === 0 ? 0 : 1));
    expect(rampCounter(sensor)).toBe(0xe9); // dark phase — level 0
    phase = 1;
    expect(rampCounter(sensor)).toBe(0x31); // bright phase — level 10
  });

  it("readData returns 0 for the output pin when the cart drives bit 3 itself", () => {
    const sensor = makeSensor(() => 1);
    sensor.onDataWrite(RESET, INPUT_DIR_FOR_OUT);
    sensor.onDataWrite(CLOCK, INPUT_DIR_FOR_OUT);
    // Cart accidentally marks bit 3 as output — chip should yield.
    const direction = INPUT_DIR_FOR_OUT | OUT;
    expect(sensor.readData(direction)).toBe(0);
  });

  it("serialises and restores its counter / sample / edge state", () => {
    const a = makeSensor(() => 0.3);
    // Pulse halfway through a ramp.
    a.onDataWrite(RESET, INPUT_DIR_FOR_OUT);
    a.onDataWrite(0, INPUT_DIR_FOR_OUT);
    for (let i = 0; i < 50; i++) {
      a.onDataWrite(CLOCK, INPUT_DIR_FOR_OUT);
      a.onDataWrite(0, INPUT_DIR_FOR_OUT);
    }

    const w = new GbaStateWriter();
    a.serialize(w);

    const b = makeSensor(() => 0.99); // different source, shouldn't matter
    b.deserialize(new GbaStateReader(w.finalize()));

    // Continuing the ramp on both should produce the same comparator
    // transitions — proves counter, lightSample, and edge state all
    // survive the round-trip.
    for (let i = 0; i < 200; i++) {
      a.onDataWrite(CLOCK, INPUT_DIR_FOR_OUT);
      a.onDataWrite(0, INPUT_DIR_FOR_OUT);
      b.onDataWrite(CLOCK, INPUT_DIR_FOR_OUT);
      b.onDataWrite(0, INPUT_DIR_FOR_OUT);
      expect(b.readData(INPUT_DIR_FOR_OUT)).toBe(a.readData(INPUT_DIR_FOR_OUT));
    }
  });
});
