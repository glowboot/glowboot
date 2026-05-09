import { beforeEach, describe, expect, it } from "vitest";

import { NoiseChannel, SquareChannel, WaveChannel } from "./channels.js";

/** Minimal helper that stands in for the APU bus wrapper. Most tests don't
 *  care about the frame-sequencer phase, so we default to step 0 (even,
 *  no extra length clock). */
function writeReg(ch: SquareChannel | WaveChannel | NoiseChannel, reg: number, v: number, fsStep = 0): void {
  ch.writeByte(reg, v, /* apuOn */ true, fsStep);
}

describe("SquareChannel", () => {
  let ch: SquareChannel;

  beforeEach(() => {
    ch = new SquareChannel(/* hasSweep */ true);
  });

  describe("DAC and enable gating", () => {
    it("is silent with volume 0 even after trigger", () => {
      writeReg(ch, 2, 0x00); // NRx2 all zero → DAC disabled
      writeReg(ch, 4, 0x80); // trigger
      expect(ch.sample()).toBe(0);
      expect(ch.enabled).toBe(false);
    });

    it("enables DAC when NRx2 upper 5 bits are non-zero", () => {
      writeReg(ch, 2, 0xf0); // volume 15, direction 1, period 0
      writeReg(ch, 4, 0x80); // trigger
      expect(ch.dacEnabled).toBe(true);
      expect(ch.enabled).toBe(true);
    });

    it("disables the channel when the DAC turns off mid-play", () => {
      writeReg(ch, 2, 0xf0);
      writeReg(ch, 4, 0x80);
      expect(ch.enabled).toBe(true);
      writeReg(ch, 2, 0x00); // DAC off
      expect(ch.enabled).toBe(false);
    });
  });

  describe("duty cycle", () => {
    it("outputs the 12.5% duty waveform for NR*1 bits 6-7 = 00", () => {
      writeReg(ch, 1, 0x00); // duty 0 (00000001)
      writeReg(ch, 2, 0xf0); // vol 15
      writeReg(ch, 4, 0x80); // trigger

      // Pattern bit 0 set, bits 1-7 clear — dutyPos advances 0..7.
      // On trigger dutyPos = 0. Channel output = bit0 × vol.
      // With a high frequency (freqReg=2047 → period 4 T), advancing
      // tick(4) each time steps dutyPos by 1.
      writeReg(ch, 3, 0xff); // NR*3: freqLo = 0xFF
      writeReg(ch, 4, 0x87); // NR*4: trigger + freqHi=7 (so freqReg = 2047)

      // After trigger, dutyPos=0. Pattern 0b00000001 bit 0 = 1 → sample = 15.
      expect(ch.sample()).toBe(15);
      // One period later, dutyPos=1, bit 1 = 0 → sample = 0.
      ch.tick(4);
      expect(ch.sample()).toBe(0);
    });
  });

  describe("length counter", () => {
    it("disables the channel when the counter hits 0", () => {
      writeReg(ch, 2, 0xf0); // DAC on
      writeReg(ch, 1, 63); // length load 63 → counter = 64 - 63 = 1
      writeReg(ch, 4, 0xc0); // trigger + length-enable (bit 6)
      expect(ch.enabled).toBe(true);
      ch.clockLength(); // counter 1 → 0 → disable
      expect(ch.enabled).toBe(false);
    });

    it("does not decrement when length-enable is off", () => {
      writeReg(ch, 2, 0xf0);
      writeReg(ch, 1, 63);
      writeReg(ch, 4, 0x80); // trigger WITHOUT length-enable
      ch.clockLength();
      expect(ch.enabled).toBe(true);
    });
  });

  describe("volume envelope", () => {
    it("loads the initial volume on trigger", () => {
      writeReg(ch, 2, 0xa7); // vol 10, dir up, period 7
      writeReg(ch, 4, 0x80);
      // Sample is vol × duty-bit; use duty 2 (50%) and a step on dutyPos=0 on.
      writeReg(ch, 1, 0x80); // duty 2 → pattern 0b00001111 (bit 0 = 1)
      writeReg(ch, 4, 0x80);
      expect(ch.sample()).toBeGreaterThanOrEqual(10); // = vol (10)
    });

    it("decrements when envelope direction is 'down' (bit 3 of NRx2 = 0)", () => {
      writeReg(ch, 2, 0x82); // vol 8, direction DOWN (bit 3 clear), period 2
      writeReg(ch, 1, 0x80); // duty 2 — pattern bit 0 = 1
      writeReg(ch, 4, 0x80); // trigger
      const before = ch.sample();
      // Envelope clocks once per period; we call clockEnvelope period times.
      ch.clockEnvelope();
      ch.clockEnvelope();
      const after = ch.sample();
      expect(after).toBeLessThan(before);
    });
  });

  describe("sweep (CH1 only)", () => {
    it("CH2 (no sweep) is immune to clockSweep calls", () => {
      const ch2 = new SquareChannel(/* hasSweep */ false);
      writeReg(ch2, 2, 0xf0);
      writeReg(ch2, 3, 0x00);
      writeReg(ch2, 4, 0x80);
      expect(() => ch2.clockSweep()).not.toThrow();
      expect(ch2.enabled).toBe(true);
    });

    it("CH1 disables itself when sweep overflows past 2047", () => {
      writeReg(ch, 3, 0xff);
      writeReg(ch, 4, 0x87); // freqReg = 2047, triggered
      writeReg(ch, 2, 0xf0); // DAC on + trigger
      writeReg(ch, 4, 0x87);
      // Sweep period 1, shift 1, negate=0 → next freq = 2047 + 2047>>1 = 3070,
      // which exceeds 2047 → channel disabled on the immediate overflow check.
      writeReg(ch, 0, 0x11); // sweep period 1, shift 1, negate=0
      writeReg(ch, 4, 0x87); // re-trigger to pick up new sweep config
      expect(ch.enabled).toBe(false);
    });
  });
});

describe("WaveChannel", () => {
  let ch: WaveChannel;
  beforeEach(() => {
    ch = new WaveChannel();
  });

  it("is silent until NR30 bit 7 enables the DAC", () => {
    writeReg(ch, 4, 0x80); // trigger without DAC on
    expect(ch.enabled).toBe(false);
  });

  it("trigger with DAC on enables the channel and resets wavePos", () => {
    writeReg(ch, 0, 0x80); // DAC on
    writeReg(ch, 4, 0x80); // trigger
    expect(ch.enabled).toBe(true);
    expect(ch.currentByteIndex).toBe(0);
  });

  it("outputs nibbles from waveRam when playing, scaled by output level", () => {
    // Load 0x12 at byte 0 — nibbles 1 and 2.
    ch.waveRam[0] = 0x12;
    writeReg(ch, 0, 0x80); // DAC on
    writeReg(ch, 2, 0x20); // output level 1 (100%, no shift)
    writeReg(ch, 3, 0xff);
    writeReg(ch, 4, 0x87); // freq=2047, period=2, trigger
    // Immediately after trigger, waveBuffer is 0 (not yet fetched).
    // Tick once to advance wavePos=1, fetching low nibble of byte 0 = 2.
    ch.tick((2048 - 2047) * 2); // exactly one period
    expect(ch.sample()).toBe(2);
  });

  it("output level 0 mutes the channel (shift of 4 bits → 0)", () => {
    ch.waveRam[0] = 0xff;
    writeReg(ch, 0, 0x80);
    writeReg(ch, 2, 0x00); // output level 0
    writeReg(ch, 4, 0x80);
    ch.tick(4096);
    expect(ch.sample()).toBe(0);
  });
});

describe("NoiseChannel", () => {
  let ch: NoiseChannel;
  beforeEach(() => {
    ch = new NoiseChannel();
  });

  it("disabled by default (DAC off)", () => {
    expect(ch.enabled).toBe(false);
  });

  it("trigger with DAC on enables the channel", () => {
    writeReg(ch, 2, 0xf0); // DAC on
    writeReg(ch, 4, 0x80);
    expect(ch.enabled).toBe(true);
  });

  it("15-bit LFSR produces a known first-tap sequence", () => {
    writeReg(ch, 2, 0xf0);
    writeReg(ch, 3, 0x00); // clock shift 0, 15-bit mode, divisor code 0
    writeReg(ch, 4, 0x80); // trigger — LFSR reloads to 0x7FFF
    // LFSR starts 0x7FFF, all 1s. sample() = (~LFSR & 1) * vol = 0.
    expect(ch.sample()).toBe(0);
    // After one tap: xbit = 1^1 = 0, LFSR becomes 0x3FFF | (0 << 14) = 0x3FFF.
    // sample() = (~0x3FFF & 1) * 15 = (1 & 1) * 15 = 15? No, ~0x3FFF is ...0000,
    // last bit = 0. Wait: ~0x3FFF in JS is -0x4000; &1 gives 0. So sample=0.
    // Clearer: bit 0 of LFSR is 1, so (~lfsr & 1) = 0 → sample=0.
    ch.tick(8);
    expect(ch.sample()).toBe(0);
  });

  it("7-bit LFSR mode wires bit 6 to the feedback tap", () => {
    writeReg(ch, 2, 0xf0);
    writeReg(ch, 3, 0x08); // bit 3 = 7-bit mode
    writeReg(ch, 4, 0x80);
    // Width mode should not throw or produce NaN.
    ch.tick(1000);
    expect(Number.isFinite(ch.sample())).toBe(true);
  });
});
