import { describe, expect, it } from "vitest";

import { GbaCartGpio, type GpioFeature } from "./gpio.js";

class CapturingFeature implements GpioFeature {
  writes: { data: number; direction: number }[] = [];
  driveValue = 0;
  onDataWrite(data: number, direction: number): void {
    this.writes.push({ data, direction });
  }
  readData(_direction: number): number {
    return this.driveValue & 0xf;
  }
}

describe("GbaCartGpio", () => {
  it("starts with read-enable off so reads fall through to cart-ROM", () => {
    const g = new GbaCartGpio();
    expect(g.readEnable).toBe(false);
  });

  it("write to 0xC8 flips read-enable on (bit 0)", () => {
    const g = new GbaCartGpio();
    g.write(0x080000c8, 1);
    expect(g.readEnable).toBe(true);
    g.write(0x080000c8, 0);
    expect(g.readEnable).toBe(false);
  });

  it("data writes fan out to features", () => {
    const g = new GbaCartGpio();
    const f1 = new CapturingFeature();
    const f2 = new CapturingFeature();
    g.addFeature(f1);
    g.addFeature(f2);
    g.write(0x080000c6, 0xf); // direction = all output
    g.write(0x080000c4, 0xa);
    expect(f1.writes).toEqual([{ data: 0xa, direction: 0xf }]);
    expect(f2.writes).toEqual([{ data: 0xa, direction: 0xf }]);
  });

  it("deduplicates equal-value writes to the data register", () => {
    const g = new GbaCartGpio();
    const f = new CapturingFeature();
    g.addFeature(f);
    g.write(0x080000c4, 0x5);
    g.write(0x080000c4, 0x5); // unchanged → no callback
    g.write(0x080000c4, 0x5);
    expect(f.writes.length).toBe(1);
  });

  it("read returns CPU-driven bits on output pins + feature bits on input pins", () => {
    const g = new GbaCartGpio();
    const f = new CapturingFeature();
    g.addFeature(f);
    // bit 0 = CPU output, CPU drives 1
    // bit 1 = cart input,  feature drives 1
    // bit 2 = CPU output, CPU drives 0
    // bit 3 = cart input,  feature drives 1
    g.write(0x080000c8, 1); // enable reads
    g.write(0x080000c6, 0b0101); // direction: bits 0 + 2 = output
    g.write(0x080000c4, 0b0001); // CPU drives bit 0 high
    f.driveValue = 0b1010; // feature drives bits 1 + 3 high
    const read = g.read(0x080000c4);
    expect(read & 1).toBe(1); // CPU output bit 0
    expect((read >>> 1) & 1).toBe(1); // feature input bit 1
    expect((read >>> 2) & 1).toBe(0); // CPU output bit 2 (low)
    expect((read >>> 3) & 1).toBe(1); // feature input bit 3
  });

  it("masks feature output to input-pin lanes only — feature can't override CPU on output pins", () => {
    const g = new GbaCartGpio();
    const f = new CapturingFeature();
    g.addFeature(f);
    g.write(0x080000c8, 1);
    g.write(0x080000c6, 0xf); // direction: ALL output
    g.write(0x080000c4, 0); // CPU drives all low
    f.driveValue = 0xf; // feature tries to drive all bits high
    // Output pins → CPU's 0 wins, feature ignored.
    expect(g.read(0x080000c4)).toBe(0);
  });

  it("read of 0xC6 returns the direction register", () => {
    const g = new GbaCartGpio();
    g.write(0x080000c6, 0xa);
    expect(g.read(0x080000c6)).toBe(0xa);
  });

  it("read of 0xC8 returns 0 / 1 mirroring read-enable", () => {
    const g = new GbaCartGpio();
    g.write(0x080000c8, 0);
    expect(g.read(0x080000c8)).toBe(0);
    g.write(0x080000c8, 1);
    expect(g.read(0x080000c8)).toBe(1);
  });

  it("read masks the data register to 4 bits", () => {
    const g = new GbaCartGpio();
    const f = new CapturingFeature();
    g.addFeature(f);
    g.write(0x080000c6, 0xf); // all output
    g.write(0x080000c4, 0xff); // upper 4 bits set in input but should be masked
    expect(g.read(0x080000c4)).toBe(0xf);
  });
});
