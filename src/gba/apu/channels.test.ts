/**
 * Unit tests for the PSG channel implementations.
 *
 * The APU integration tests in `apu.test.ts` exercise channels through
 * the bus — these tests drive each channel directly so internal
 * behaviour (sweep overflow disable, duty pattern, LFSR full cycle,
 * wave 75% override, volume-shift table) is pinned without the bus
 * routing in the way.
 */

import { describe, expect, it } from "vitest";

import { NoiseChannel, SquareChannel, WaveChannel } from "./channels.js";

describe("SquareChannel", () => {
  function enable(ch: SquareChannel, opts: { duty?: number; freq?: number; volume?: number } = {}): void {
    const duty = opts.duty ?? 2;
    const volume = opts.volume ?? 0xf;
    const freq = opts.freq ?? 0;
    // envelope: volume in top nibble, dir=0 (down), period=0 (off).
    ch.setEnvelopeAndDuty((volume << 12) | (duty << 6));
    ch.setFrequencyControl((1 << 15) | freq);
  }

  it("duty 50% (mode 2) outputs +volume for half the cycle and -volume for the other half", () => {
    const ch = new SquareChannel();
    enable(ch, { duty: 2, freq: 0, volume: 8 });
    // Step through all 8 duty positions; pattern 0xe1 = 11100001 means
    // positions 0, 5, 6, 7 are HIGH; positions 1-4 are LOW.
    // (bit N LSB-first → high when bit set)
    const highs: number[] = [];
    for (let pos = 0; pos < 8; pos++) {
      ch.dutyPosition = pos;
      highs.push(ch.sample() > 0 ? 1 : 0);
    }
    // 0xe1 = 0b11100001 → bit 0 = 1, bits 1-4 = 0, bits 5-7 = 1.
    expect(highs).toEqual([1, 0, 0, 0, 0, 1, 1, 1]);
  });

  it("DAC-disable (volume + direction both zero) silences the channel", () => {
    const ch = new SquareChannel();
    ch.setEnvelopeAndDuty(0); // no volume, no direction → DAC off
    ch.setFrequencyControl(1 << 15); // trigger anyway
    expect(ch.enabled).toBe(false);
    expect(ch.sample()).toBe(0);
  });

  it("duty timer underflows after (2048 - freq) * 16 cycles per step", () => {
    const ch = new SquareChannel();
    // freq = 2046 → (2048 - 2046) * 16 = 32 cycles per step.
    enable(ch, { freq: 2046 });
    expect(ch.dutyPosition).toBe(0);
    ch.tickDuty(31);
    expect(ch.dutyPosition).toBe(0);
    ch.tickDuty(1);
    expect(ch.dutyPosition).toBe(1);
    ch.tickDuty(32 * 3);
    expect(ch.dutyPosition).toBe(4);
  });

  it("sweep direction-down decreases frequency", () => {
    const ch = new SquareChannel();
    // sweep: period=1, dir=down, shift=2.
    ch.setSweep((1 << 4) | (1 << 3) | 2);
    enable(ch, { freq: 0x400 }); // 1024 → 1024 - (1024>>2) = 768
    ch.clockSweep();
    expect(ch.frequency).toBe(0x400 - (0x400 >>> 2));
  });

  it("sweep overflow on the second-check after commit disables the channel", () => {
    const ch = new SquareChannel();
    // sweep: period=1, dir=up, shift=1. Trigger check: 1024 + 512 = 1536
    // (OK, ≤ 2047), so channel stays enabled. First clockSweep commits
    // shadow to 1536, then the immediate second check is 1536 + 768 =
    // 2304 > 2047 → disable.
    ch.setSweep((1 << 4) | 1);
    enable(ch, { freq: 1024 });
    expect(ch.enabled).toBe(true);
    ch.clockSweep();
    expect(ch.enabled).toBe(false);
  });

  it("trigger-time sweep overflow check disables immediately", () => {
    const ch = new SquareChannel();
    // sweep: period=0, shift=1, dir=up. Trigger-time check uses
    // shadow=freq=2000 → 3000 > 2047, disables on the trigger itself.
    ch.setSweep(1);
    enable(ch, { freq: 2000 });
    expect(ch.enabled).toBe(false);
  });

  it("envelope down saturates at 0 and stops running", () => {
    const ch = new SquareChannel();
    // env: init=2, dir=down, period=1.
    ch.setEnvelopeAndDuty((2 << 12) | (1 << 8));
    ch.setFrequencyControl(1 << 15);
    expect(ch.volume).toBe(2);
    ch.clockEnvelope();
    expect(ch.volume).toBe(1);
    ch.clockEnvelope();
    expect(ch.volume).toBe(0);
    // Now saturated — further clocks must not wrap.
    ch.clockEnvelope();
    ch.clockEnvelope();
    expect(ch.volume).toBe(0);
  });

  it("envelope up saturates at 15", () => {
    const ch = new SquareChannel();
    // env: init=14, dir=up (bit 11), period=1.
    ch.setEnvelopeAndDuty((14 << 12) | (1 << 11) | (1 << 8));
    ch.setFrequencyControl(1 << 15);
    expect(ch.volume).toBe(14);
    ch.clockEnvelope();
    expect(ch.volume).toBe(15);
    ch.clockEnvelope();
    ch.clockEnvelope();
    expect(ch.volume).toBe(15);
  });

  it("length expiry disables the channel after lengthMax (64) length clocks", () => {
    const ch = new SquareChannel();
    enable(ch, { volume: 0xf });
    // length-enable on, length spec = 0 → counter = 64.
    ch.setFrequencyControl((1 << 15) | (1 << 14));
    for (let i = 0; i < 63; i++) ch.clockLength();
    expect(ch.enabled).toBe(true);
    ch.clockLength();
    expect(ch.enabled).toBe(false);
  });
});

describe("WaveChannel", () => {
  function makeRam(): Uint8Array {
    // 32 nibbles in 16 bytes — nibble N = N (so position N produces
    // sample N after centring).
    const ram = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ram[i] = (i * 2) | 0x01; // hi nibble = even, lo nibble = even+1 — distinct values
    // Easier: just (2N) << 4 | (2N+1)
    for (let i = 0; i < 16; i++) ram[i] = ((i * 2) << 4) | (i * 2 + 1);
    return ram;
  }

  function trigger(ch: WaveChannel, opts: { volBits?: number; force75?: boolean; freq?: number } = {}): void {
    // SOUND3CNT_L: DAC enable (bit 7), single bank.
    ch.setControl(1 << 7);
    const volBits = opts.volBits ?? 1; // 1 = full volume
    const force = opts.force75 ? 1 << 15 : 0;
    ch.setLengthAndVolume((volBits << 13) | force);
    ch.setFrequencyControl((1 << 15) | (opts.freq ?? 0));
  }

  it("DAC-disable (SOUND3CNT_L bit 7 clear) keeps channel silent", () => {
    const ch = new WaveChannel();
    ch.attachWaveRam(makeRam());
    ch.setControl(0); // DAC off
    ch.setLengthAndVolume(1 << 13);
    ch.setFrequencyControl(1 << 15);
    expect(ch.enabled).toBe(false);
    expect(ch.sample()).toBe(0);
  });

  it("volume bits 0/1/2/3 map to mute / full / half / quarter", () => {
    const ch = new WaveChannel();
    const ram = new Uint8Array(16);
    ram[0] = 0xf0; // first nibble = 15 → centred to +15
    ch.attachWaveRam(ram);

    trigger(ch, { volBits: 1 }); // 100%
    expect(ch.sample()).toBe(15);

    trigger(ch, { volBits: 2 }); // 50%
    expect(ch.sample()).toBe(15 >> 1);

    trigger(ch, { volBits: 3 }); // 25%
    expect(ch.sample()).toBe(15 >> 2);

    trigger(ch, { volBits: 0 }); // mute (>>4 of small range = 0)
    expect(ch.sample()).toBe(0);
  });

  it("force-75% bit (SOUND3CNT_H bit 15) overrides the volume shift to ~75%", () => {
    const ch = new WaveChannel();
    const ram = new Uint8Array(16);
    ram[0] = 0xf0; // first nibble = 15 → centred +15
    ch.attachWaveRam(ram);
    // Set volume to mute, then engage force-75%. Force-75% must win.
    trigger(ch, { volBits: 0, force75: true });
    expect(ch.sample()).toBe((15 * 3) >> 2);
  });

  it("position advances every (2048 - freq) * 8 cycles", () => {
    const ch = new WaveChannel();
    ch.attachWaveRam(makeRam());
    trigger(ch, { freq: 2040 }); // (2048-2040)*8 = 64 cycles
    expect(ch.position).toBe(0);
    ch.tickWave(63);
    expect(ch.position).toBe(0);
    ch.tickWave(1);
    expect(ch.position).toBe(1);
    ch.tickWave(64 * 5);
    expect(ch.position).toBe(6);
  });

  it("position wraps at 32 in single-bank mode", () => {
    const ch = new WaveChannel();
    ch.attachWaveRam(makeRam());
    trigger(ch, { freq: 2047 }); // 8 cycles per step
    ch.tickWave(8 * 33);
    expect(ch.position).toBe(1); // 33 % 32 = 1
  });

  it("double-bank mode wraps at 64 instead of 32", () => {
    const ch = new WaveChannel();
    ch.attachWaveRam(makeRam());
    // Re-set control with double-bank bit (bit 5) plus DAC enable.
    ch.setControl((1 << 7) | (1 << 5));
    ch.setLengthAndVolume(1 << 13);
    ch.setFrequencyControl((1 << 15) | 2047);
    ch.tickWave(8 * 64);
    expect(ch.position).toBe(0); // wrapped exactly
    ch.tickWave(8 * 50);
    expect(ch.position).toBe(50);
  });
});

describe("NoiseChannel", () => {
  function enable(
    ch: NoiseChannel,
    opts: { volume?: number; ratio?: number; shift?: number; narrow?: boolean } = {}
  ): void {
    const volume = opts.volume ?? 0xf;
    ch.setEnvelope(volume << 12); // dir=down, period=0 (env off), DAC on
    const ratio = opts.ratio ?? 0;
    const shift = opts.shift ?? 0;
    const narrow = opts.narrow ? 1 << 3 : 0;
    ch.setFrequencyControl((1 << 15) | (shift << 4) | narrow | ratio);
  }

  it("DAC-disable (envelope nibble all-zero) leaves channel disabled on trigger", () => {
    const ch = new NoiseChannel();
    ch.setEnvelope(0);
    ch.setFrequencyControl(1 << 15);
    expect(ch.enabled).toBe(false);
    expect(ch.sample()).toBe(0);
  });

  it("trigger seeds the LFSR to 0x7FFF — initial sample is -volume (bit 0 = 1)", () => {
    const ch = new NoiseChannel();
    enable(ch, { volume: 5 });
    // LFSR = 0x7FFF → bit 0 = 1 → sample = -volume.
    expect(ch.sample()).toBe(-5);
  });

  it("period formula scales linearly with divisor and exponentially with shift", () => {
    // sample() only exposes bit 0 of the LFSR, so per-step movement is
    // hard to observe directly. Instead we count the CPU cycles needed
    // for the sample to first flip from -volume to +volume. From seed
    // 0x7FFF, that takes exactly 15 LFSR-steps regardless of period —
    // so total cycles = 15 × (period in cycles), which lets us verify
    // the divisor/shift formula by ratio.
    function cyclesUntilFlip(opts: { ratio: number; shift: number }): number {
      const ch = new NoiseChannel();
      enable(ch, opts);
      const initial = ch.sample();
      for (let cycles = 1; cycles < 1_000_000; cycles++) {
        ch.tickLfsr(1);
        if (ch.sample() !== initial) return cycles;
      }
      throw new Error("sample never flipped");
    }
    // Periods scaled ×4 from the CGB T-cycle formula to GBA cycles
    // (16.78 MHz vs 4.19 MHz). divisor 8 ⇒ 32 GBA cycles per step, etc.
    expect(cyclesUntilFlip({ ratio: 0, shift: 0 })).toBe(15 * 32); // divisor 8 × 4
    expect(cyclesUntilFlip({ ratio: 0, shift: 1 })).toBe(15 * 64); // shift doubles
    expect(cyclesUntilFlip({ ratio: 2, shift: 0 })).toBe(15 * 128); // divisor 32 × 4
    expect(cyclesUntilFlip({ ratio: 1, shift: 2 })).toBe(15 * 256); // 16 << 2 × 4
  });

  it("15-bit LFSR returns to its seed after exactly 32767 steps", () => {
    const ch = new NoiseChannel();
    enable(ch, { ratio: 0, shift: 0 }); // period 32 GBA cycles
    // Step 32767 times — seed has bit 0 = 1, so sample = -volume.
    // Returning to seed means sample is once again -volume. (We can't
    // observe non-seed states distinctly through sample(), which only
    // exposes bit 0 of the full 15-bit LFSR.)
    ch.tickLfsr(32 * 32767);
    expect(ch.sample()).toBe(-15);
  });

  it("narrow (7-bit) LFSR cycles every 127 steps", () => {
    const ch = new NoiseChannel();
    enable(ch, { ratio: 0, shift: 0, narrow: true });
    const seed = ch.sample();
    ch.tickLfsr(32 * 127);
    expect(ch.sample()).toBe(seed);
  });

  it("sample is +volume when LFSR bit 0 = 0 and -volume when bit 0 = 1", () => {
    const ch = new NoiseChannel();
    enable(ch, { ratio: 0, shift: 0, volume: 7 });
    // Step until bit 0 flips. Initial seed 0x7FFF has bit 0 = 1 → -7.
    expect(ch.sample()).toBe(-7);
    // After one period the LFSR bit_new = 1 XOR 1 = 0, shift right →
    // 0x3FFF, bit 0 = 1 → still -7. Iterate until bit 0 is 0.
    let saw0 = false;
    for (let i = 0; i < 30; i++) {
      ch.tickLfsr(32);
      if (ch.sample() === 7) {
        saw0 = true;
        break;
      }
    }
    expect(saw0).toBe(true);
  });

  it("length expiry disables the channel after lengthMax (64) clocks", () => {
    const ch = new NoiseChannel();
    ch.setEnvelope(0xf << 12);
    ch.setFrequencyControl((1 << 15) | (1 << 14)); // trigger + length-enable
    for (let i = 0; i < 63; i++) ch.clockLength();
    expect(ch.enabled).toBe(true);
    ch.clockLength();
    expect(ch.enabled).toBe(false);
  });
});
