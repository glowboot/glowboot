import { describe, expect, it } from "vitest";

import { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import {
  cartHasTiltSensor,
  TILT_ARM_ADDR,
  TILT_TRIGGER_ADDR,
  TILT_X_HIGH_ADDR,
  TILT_X_LOW_ADDR,
  TILT_Y_HIGH_ADDR,
  TILT_Y_LOW_ADDR,
  TiltSensor
} from "./accelerometer.js";
import type { GbaHeader } from "./header.js";

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

describe("cartHasTiltSensor", () => {
  it.each([
    ["KYGE", true],
    ["KYGP", true],
    ["KYGJ", true],
    ["KHPJ", true],
    ["V49E", false],
    ["BPEE", false],
    ["AGBE", false]
  ])("%s → %s", (code, expected) => {
    expect(cartHasTiltSensor(header(code))).toBe(expected);
  });
});

describe("TiltSensor", () => {
  it("powers on with both rawX/rawY at 0xFFF and the X-high status bit set", () => {
    const t = new TiltSensor();
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0xff);
    // Status bit is unconditional — the cart's "is the sensor present"
    // probe runs before any arm/trigger sequence and would otherwise
    // think the chip is dead.
    expect(t.read8(TILT_X_HIGH_ADDR)).toBe(0xf | 0x80);
    expect(t.read8(TILT_Y_LOW_ADDR)).toBe(0xff);
    // Y-high carries no status bit on real silicon.
    expect(t.read8(TILT_Y_HIGH_ADDR)).toBe(0xf);
  });

  it("a 0x55 then 0xAA write latches the current tilt vector at the documented centres", () => {
    const t = new TiltSensor();
    t.tiltSource = () => ({ x: 0, y: 0 });
    t.write8(TILT_ARM_ADDR, 0x55);
    t.write8(TILT_TRIGGER_ADDR, 0xaa);
    // X centre 0x392 → low 0x92, high 0x3
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0x92);
    expect(t.read8(TILT_X_HIGH_ADDR)).toBe(0x3 | 0x80);
    // Y centre 0x3A0 → low 0xA0, high 0x3
    expect(t.read8(TILT_Y_LOW_ADDR)).toBe(0xa0);
    expect(t.read8(TILT_Y_HIGH_ADDR)).toBe(0x3);
  });

  it("positive host-X tilt lands inside the documented chip range", () => {
    const t = new TiltSensor();
    t.tiltSource = () => ({ x: 1, y: 0 });
    t.write8(TILT_ARM_ADDR, 0x55);
    t.write8(TILT_TRIGGER_ADDR, 0xaa);
    // 0x392 + 0xE0 = 0x472 (just under GBATEK max 0x477) → low 0x72, high 0x4
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0x72);
    expect(t.read8(TILT_X_HIGH_ADDR) & 0x0f).toBe(0x4);
  });

  it("negative host-Y tilt lands inside the documented chip range", () => {
    const t = new TiltSensor();
    t.tiltSource = () => ({ x: 0, y: -1 });
    t.write8(TILT_ARM_ADDR, 0x55);
    t.write8(TILT_TRIGGER_ADDR, 0xaa);
    // 0x3A0 - 0xE0 = 0x2C0 (just above GBATEK min 0x2C3) → low 0xC0, high 0x2
    expect(t.read8(TILT_Y_LOW_ADDR)).toBe(0xc0);
    expect(t.read8(TILT_Y_HIGH_ADDR) & 0x0f).toBe(0x2);
  });

  it("clamps extreme tilt values to the 12-bit range", () => {
    const t = new TiltSensor();
    t.tiltSource = () => ({ x: 100, y: -100 });
    t.write8(TILT_ARM_ADDR, 0x55);
    t.write8(TILT_TRIGGER_ADDR, 0xaa);
    // x = +100 saturates above → 0xFFF
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0xff);
    expect(t.read8(TILT_X_HIGH_ADDR) & 0x0f).toBe(0xf);
    // y = -100 saturates below → 0x000
    expect(t.read8(TILT_Y_LOW_ADDR)).toBe(0x00);
    expect(t.read8(TILT_Y_HIGH_ADDR) & 0x0f).toBe(0x0);
  });

  it("trigger without a preceding arm is ignored", () => {
    const t = new TiltSensor();
    let polled = 0;
    t.tiltSource = () => {
      polled++;
      return { x: 0.5, y: 0 };
    };
    t.write8(TILT_TRIGGER_ADDR, 0xaa);
    expect(polled).toBe(0);
    // Registers stay at their power-on default — the cart will see
    // 0xFFF rather than the new sample.
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0xff);
  });

  it("a non-magic byte in either slot is rejected", () => {
    const t = new TiltSensor();
    t.tiltSource = () => ({ x: 0.5, y: 0 });
    t.write8(TILT_ARM_ADDR, 0x44); // wrong arm value
    t.write8(TILT_TRIGGER_ADDR, 0xaa);
    // Sample never latched; rawX still at the power-on default.
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0xff);

    t.write8(TILT_ARM_ADDR, 0x55);
    t.write8(TILT_TRIGGER_ADDR, 0x99); // wrong trigger value
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0xff);
  });

  it("reads outside the four data slots return 0xFF", () => {
    const t = new TiltSensor();
    expect(t.read8(TILT_ARM_ADDR)).toBe(0xff);
    expect(t.read8(TILT_TRIGGER_ADDR)).toBe(0xff);
    expect(t.read8(0x0e008250)).toBe(0xff);
  });

  it("write to unrecognised addresses inside the window is a no-op", () => {
    const t = new TiltSensor();
    t.write8(0x0e008050, 0x55);
    t.write8(TILT_X_LOW_ADDR, 0xff);
    // The bogus 0x8050 write didn't arm the chip, so a follow-up
    // trigger to the canonical slot doesn't fire either.
    t.write8(TILT_TRIGGER_ADDR, 0xaa);
    expect(t.read8(TILT_X_LOW_ADDR)).toBe(0xff); // still at power-on default
  });

  it("covers() identifies exactly the six active slots", () => {
    expect(TiltSensor.covers(TILT_ARM_ADDR)).toBe(true);
    expect(TiltSensor.covers(TILT_TRIGGER_ADDR)).toBe(true);
    expect(TiltSensor.covers(TILT_X_LOW_ADDR)).toBe(true);
    expect(TiltSensor.covers(TILT_X_HIGH_ADDR)).toBe(true);
    expect(TiltSensor.covers(TILT_Y_LOW_ADDR)).toBe(true);
    expect(TiltSensor.covers(TILT_Y_HIGH_ADDR)).toBe(true);
    expect(TiltSensor.covers(TILT_ARM_ADDR + 1)).toBe(false);
    expect(TiltSensor.covers(0x0e008250)).toBe(false);
  });

  it("serialises and restores its full latched state", () => {
    const a = new TiltSensor();
    a.tiltSource = () => ({ x: 0.5, y: -0.25 });
    a.write8(TILT_ARM_ADDR, 0x55);
    a.write8(TILT_TRIGGER_ADDR, 0xaa);

    const w = new GbaStateWriter();
    a.serialize(w);

    const b = new TiltSensor();
    b.deserialize(new GbaStateReader(w.finalize()));

    expect(b.read8(TILT_X_LOW_ADDR)).toBe(a.read8(TILT_X_LOW_ADDR));
    expect(b.read8(TILT_X_HIGH_ADDR)).toBe(a.read8(TILT_X_HIGH_ADDR));
    expect(b.read8(TILT_Y_LOW_ADDR)).toBe(a.read8(TILT_Y_LOW_ADDR));
    expect(b.read8(TILT_Y_HIGH_ADDR)).toBe(a.read8(TILT_Y_HIGH_ADDR));
  });
});
