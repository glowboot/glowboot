import { describe, expect, it } from "vitest";

import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import { Apu, DirectSoundFifo } from "./apu.js";

describe("Apu — register I/O", () => {
  // Offsets used here are relative to APU_BASE (0x4000060) — the
  // IoHandler contract gives us bus-resolved offsets, not absolute
  // MMIO addresses. So SOUND1CNT_L lives at offset 0x00, not 0x60.

  it("each PSG channel CNT register stores all written bits but reads back only the bits the hardware exposes", () => {
    const apu = new Apu();
    apu.write16(0x00, 0xffff); // SOUND1CNT_L — read mask 0x007F (sweep params)
    apu.write16(0x02, 0xffff); // SOUND1CNT_H — read mask 0xFFC0 (length is write-only)
    apu.write16(0x04, 0xffff); // SOUND1CNT_X — read mask 0x4000 (only length-enable)
    expect(apu.read16(0x00)).toBe(0x007f);
    expect(apu.read16(0x02)).toBe(0xffc0);
    expect(apu.read16(0x04)).toBe(0x4000);
    // Underlying storage still holds the full written value — the
    // channel impls use the write-only bits (e.g. frequency, length
    // load) internally.
    expect(apu.psg[0]!.cntL).toBe(0xffff);
    expect(apu.psg[0]!.cntH).toBe(0xffff);
    expect(apu.psg[0]!.cntX).toBe(0xffff);
  });

  it("SOUND4 maps to PSG index 3", () => {
    const apu = new Apu();
    apu.write16(0x18, 0xff00); // SOUND4CNT_L
    apu.write16(0x1c, 0x00ff); // SOUND4CNT_H
    expect(apu.psg[3]!.cntL).toBe(0xff00);
    expect(apu.psg[3]!.cntH).toBe(0x00ff);
  });

  it("SOUNDCNT_X master-enable bit is writable; status bits are read-only", () => {
    const apu = new Apu();
    apu.soundcntX = 0x000f; // simulate channels reporting on
    apu.write16(0x24, 0x0080); // SOUNDCNT_X: write status=0 + set master enable
    expect(apu.masterEnabled).toBe(true);
    expect(apu.soundcntX & 0x000f).toBe(0x000f);
  });

  it("SOUNDBIAS default + round-trip", () => {
    const apu = new Apu();
    expect(apu.soundbias).toBe(0x0200);
    apu.write16(0x28, 0xc200); // SOUNDBIAS
    expect(apu.read16(0x28)).toBe(0xc200);
  });

  it("WAVE_RAM bytes round-trip through 16-bit access", () => {
    const apu = new Apu();
    apu.write16(0x30, 0xbeef); // WAVE_RAM[0..1]
    apu.write16(0x3e, 0xdead); // WAVE_RAM[14..15]
    expect(apu.read16(0x30)).toBe(0xbeef);
    expect(apu.read16(0x3e)).toBe(0xdead);
    expect(apu.waveRam[0]).toBe(0xef);
    expect(apu.waveRam[1]).toBe(0xbe);
  });

  it("FIFO_A is write-only — reads return zero", () => {
    const apu = new Apu();
    apu.write32(0x40, 0x12345678); // FIFO_A
    expect(apu.read32(0x40)).toBe(0);
  });
});

describe("DirectSoundFifo", () => {
  it("push32 enqueues 4 signed samples LSB-first", () => {
    const fifo = new DirectSoundFifo();
    // Sample bytes: 0x01, 0x80 (-128), 0xff (-1), 0x7f (127)
    fifo.push32(0x7fff8001);
    expect(fifo.fill).toBe(4);
    expect(fifo.pop()).toBe(0x01);
    expect(fifo.pop()).toBe(-128);
    expect(fifo.pop()).toBe(-1);
    expect(fifo.pop()).toBe(127);
    expect(fifo.fill).toBe(0);
  });

  it("excess pushes are dropped silently once 32 samples are queued", () => {
    // Real hardware sizes each FIFO at 8 × 32-bit words = 32 bytes /
    // 32 samples. With the half-full refill watermark the drop path
    // never fires in normal game programming, but the guard stays
    // active as a defensive backstop.
    const fifo = new DirectSoundFifo();
    for (let word = 0; word < 8; word++) {
      const base = word * 4 + 1;
      fifo.push32(base | ((base + 1) << 8) | ((base + 2) << 16) | ((base + 3) << 24));
    }
    expect(fifo.fill).toBe(32);
    fifo.push32(0x40414243); // overflow — dropped
    expect(fifo.fill).toBe(32);
    for (let i = 0; i < 32; i++) expect(fifo.pop()).toBe(i + 1);
  });

  it("pop on empty returns 0", () => {
    const fifo = new DirectSoundFifo();
    expect(fifo.pop()).toBe(0);
    expect(fifo.fill).toBe(0);
  });

  it("32-bit write to FIFO_A pushes 4 samples in one shot", () => {
    const apu = new Apu();
    apu.write32(0x40, 0x7f80ff01);
    expect(apu.fifoA.fill).toBe(4);
    expect(apu.fifoA.pop()).toBe(0x01);
    expect(apu.fifoA.pop()).toBe(-1);
    expect(apu.fifoA.pop()).toBe(-128);
    expect(apu.fifoA.pop()).toBe(127);
  });

  it("32-bit write to FIFO_B targets the other FIFO", () => {
    const apu = new Apu();
    apu.write32(0x44, 0x04030201);
    expect(apu.fifoA.fill).toBe(0);
    expect(apu.fifoB.fill).toBe(4);
  });
});

describe("Apu — PSG mute", () => {
  function enableMaster(apu: Apu): void {
    apu.write16(0x24, 0x0080);
  }
  function triggerCh1Loud(apu: Apu): void {
    apu.write16(0x02, (0xf << 12) | (2 << 6)); // duty 50%, full vol
    apu.write16(0x04, 1 << 15); // trigger
  }

  it("muteChannel zeroes a triggered channel without disabling it", () => {
    const apu = new Apu();
    enableMaster(apu);
    triggerCh1Loud(apu);
    apu.tick(1);
    expect(apu.samplePsg()).toBeGreaterThan(0);
    apu.muteChannel[0] = true;
    // Channel still ENABLED (status bit holds, length still ticks),
    // it just doesn't contribute samples to the mix.
    expect(apu.ch1.enabled).toBe(true);
    expect(apu.samplePsg()).toBe(0);
    apu.muteChannel[0] = false;
    expect(apu.samplePsg()).toBeGreaterThan(0);
  });

  it("muting a single PSG channel doesn't affect the others", () => {
    const apu = new Apu();
    enableMaster(apu);
    triggerCh1Loud(apu);
    // Enable ch2 too — duty 50%, full vol, trigger.
    apu.write16(0x08, (0xf << 12) | (2 << 6));
    apu.write16(0x0c, 1 << 15);
    apu.tick(1);
    apu.muteChannel[0] = true;
    expect(apu.ch1.enabled).toBe(true);
    expect(apu.ch2.enabled).toBe(true);
    // ch2 still audible.
    expect(apu.samplePsg()).toBeGreaterThan(0);
  });

  it("muteDirectSound zeroes the DS A/B mix without affecting PSG", () => {
    // Most commercial GBA games play music via Direct Sound (FIFO-
    // driven streamed PCM); PSG mute alone leaves them audible. This
    // verifies the DS-only mute path.
    const apu = new Apu();
    enableMaster(apu);
    // SOUNDCNT_H: DSA both sides @ 100%, PSG @ 100% mix.
    apu.write16(0x22, (1 << 9) | (1 << 8) | (1 << 2));
    apu.write32(0x40, 0x7f7f7f7f); // 4 max-positive DSA samples
    apu.onTimerOverflow(0);
    const stereoOn = apu.sampleStereo();
    expect(stereoOn.left).toBeGreaterThan(0);

    apu.muteDirectSoundA = true;
    apu.muteDirectSoundB = true;
    const stereoMuted = apu.sampleStereo();
    expect(stereoMuted.left).toBe(0);
    // PSG mute flags are independent — flipping DS doesn't touch them.
    expect(apu.muteChannel).toEqual([false, false, false, false]);
  });

  it("DS mute and PSG mute combine to fully silence the GBA mix", () => {
    const apu = new Apu();
    enableMaster(apu);
    // PSG ch1 + DSA both loud.
    triggerCh1Loud(apu);
    apu.write16(0x22, (1 << 9) | (1 << 8) | (1 << 2));
    apu.write32(0x40, 0x7f7f7f7f);
    apu.onTimerOverflow(0);
    apu.tick(1);
    expect(apu.sampleStereo().left).toBeGreaterThan(0);

    for (let i = 0; i < 4; i++) apu.muteChannel[i] = true;
    apu.muteDirectSoundA = true;
    apu.muteDirectSoundB = true;
    expect(apu.sampleStereo().left).toBe(0);
    expect(apu.sampleStereo().right).toBe(0);
  });
});

describe("Apu — PSG channel 1 (square + sweep)", () => {
  function enable(apu: Apu): void {
    apu.write16(0x24, 0x0080); // SOUNDCNT_X master enable
  }

  it("trigger sets the channel-on status bit and starts producing samples", () => {
    const apu = new Apu();
    enable(apu);
    // SOUND1CNT_H: envelope init vol = 0xF, direction down, period 0, duty 2 (50%)
    apu.write16(0x02, (0xf << 12) | (0 << 11) | (0 << 8) | (2 << 6) | 0);
    // SOUND1CNT_X: trigger, frequency 0 (slow), no length-enable
    apu.write16(0x04, (1 << 15) | 0);
    apu.tick(1);
    expect(apu.ch1.enabled).toBe(true);
    expect(apu.read16(0x24) & 0x01).toBe(0x01); // status bits synced on read
    // With duty 2 (mask 0xE1 = 1110_0001), step 0 → bit 0 = 1 → high.
    // First sample (step 0, volume 15) should be positive.
    expect(apu.samplePsg()).toBeGreaterThan(0);
  });

  it("length expiry disables the channel after `lengthCounter` length clocks", () => {
    const apu = new Apu();
    enable(apu);
    // Length = 63 → counter = 64 - 63 = 1.
    apu.write16(0x02, (0xf << 12) | 63);
    apu.write16(0x04, (1 << 15) | (1 << 14)); // trigger + length enable
    expect(apu.ch1.enabled).toBe(true);
    // Run for one full frame-sequencer cycle to fire the length clock.
    // Length is clocked on steps 0,2,4,6 (every 4 FS ticks = every other step
    // is silent). Advancing one FS period fires step (current+1).
    // The lengthCounter is reloaded to 1 on trigger; the first length
    // clock should decrement it to 0 and disable.
    for (let i = 0; i < 8; i++) apu.tick(32768);
    expect(apu.ch1.enabled).toBe(false);
  });

  it("envelope clock decreases volume each envelope step", () => {
    const apu = new Apu();
    enable(apu);
    // Envelope: init vol = 0xF, direction = down, period = 1.
    apu.write16(0x02, (0xf << 12) | (0 << 11) | (1 << 8));
    apu.write16(0x04, 1 << 15); // trigger
    expect(apu.ch1.volume).toBe(0xf);
    // Envelope is clocked at FS step 7 — one FS tick away in fresh state
    // depends on starting step. Run 16 FS periods to be sure of at least
    // one step-7 fire.
    for (let i = 0; i < 16; i++) apu.tick(32768);
    expect(apu.ch1.volume).toBeLessThan(0xf);
  });

  it("sweep with downward shift reduces the channel frequency over time", () => {
    const apu = new Apu();
    enable(apu);
    // Sweep: period 1, direction down, shift 1.
    apu.write16(0x00, (1 << 4) | (1 << 3) | 1);
    apu.write16(0x02, (0xf << 12) | (2 << 6)); // envelope full, duty 50%
    apu.write16(0x04, (1 << 15) | 1024); // trigger at freq 1024
    expect(apu.ch1.frequency).toBe(1024);
    // Sweep is clocked at FS step 2 and 6 — run 16 FS periods.
    for (let i = 0; i < 16; i++) apu.tick(32768);
    expect(apu.ch1.frequency).toBeLessThan(1024);
  });

  it("duty cycle advances by 1 step every (2048 - freq) * 16 cycles", () => {
    const apu = new Apu();
    enable(apu);
    apu.write16(0x02, (0xf << 12) | (2 << 6)); // duty 50%, envelope full
    apu.write16(0x04, (1 << 15) | 2040); // freq=2040 → period = 8 * 16 = 128 cycles/step
    const start = apu.ch1.dutyPosition;
    apu.tick(128);
    expect(apu.ch1.dutyPosition).toBe((start + 1) & 7);
  });

  it("writing 0 to upper envelope bits disables the DAC and silences the channel", () => {
    const apu = new Apu();
    enable(apu);
    apu.write16(0x02, (0xf << 12) | (2 << 6));
    apu.write16(0x04, 1 << 15); // trigger
    expect(apu.ch1.enabled).toBe(true);
    // Clear init vol + direction → DAC disable bits = 0.
    apu.write16(0x02, 0);
    expect(apu.ch1.enabled).toBe(false);
    expect(apu.ch1.dacEnabled).toBe(false);
  });
});

describe("Apu — PSG channel 2 (square, no sweep)", () => {
  it("trigger via SOUND2CNT_H starts the channel", () => {
    const apu = new Apu();
    apu.write16(0x24, 0x0080); // master enable
    // SOUND2CNT_L (at 0x08): envelope + duty
    apu.write16(0x08, (0xf << 12) | (2 << 6));
    // SOUND2CNT_H (at 0x0C): freq + trigger
    apu.write16(0x0c, (1 << 15) | 1024);
    apu.tick(1);
    expect(apu.ch2.enabled).toBe(true);
    expect(apu.read16(0x24) & 0x02).toBe(0x02); // status bits synced on read
  });
});

describe("Apu — PSG channel 3 (wave RAM)", () => {
  function enable(apu: Apu): void {
    apu.write16(0x24, 0x0080); // SOUNDCNT_X master enable
  }

  function writeWaveRam(apu: Apu, bytes: number[]): void {
    for (let i = 0; i < bytes.length && i < 16; i++) {
      const aligned = 0x30 + (i & ~1);
      const cur = apu.read16(aligned);
      const merged = (i & 1) === 0 ? (cur & 0xff00) | (bytes[i]! & 0xff) : (cur & 0x00ff) | ((bytes[i]! & 0xff) << 8);
      apu.write16(aligned, merged);
    }
  }

  it("trigger via SOUND3CNT_X starts the wave channel when the DAC is enabled", () => {
    const apu = new Apu();
    enable(apu);
    apu.write16(0x10, 1 << 7); // SOUND3CNT_L: DAC enable
    apu.write16(0x12, 1 << 13); // SOUND3CNT_H: full volume, length 0
    apu.write16(0x14, 1 << 15); // SOUND3CNT_X: trigger
    apu.tick(1);
    expect(apu.ch3.enabled).toBe(true);
    expect(apu.read16(0x24) & 0x04).toBe(0x04); // status bits synced on read
  });

  it("DAC disabled (SOUND3CNT_L bit 7 = 0) silences the channel and refuses trigger", () => {
    const apu = new Apu();
    enable(apu);
    apu.write16(0x10, 0); // DAC disabled
    apu.write16(0x12, 1 << 13);
    apu.write16(0x14, 1 << 15); // trigger
    expect(apu.ch3.enabled).toBe(false);
  });

  it("wave RAM samples drive the output", () => {
    const apu = new Apu();
    enable(apu);
    // Wave RAM: alternating 0x0F nibbles (high) and 0x00 (low) — first byte
    // 0xF0 (high nibble = 15, low nibble = 0).
    writeWaveRam(apu, [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0]);
    apu.write16(0x10, 1 << 7); // DAC enable, single-bank, bank 0
    apu.write16(0x12, 1 << 13); // full volume
    apu.write16(0x14, 1 << 15); // trigger, freq 0 (slowest)
    apu.tick(1);
    // First sample is wave RAM byte 0 high nibble = 15 → centred to +15.
    expect(apu.ch3.sample()).toBe(15);
  });

  it("volume bits 50% halves the output", () => {
    const apu = new Apu();
    enable(apu);
    writeWaveRam(apu, [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0]);
    apu.write16(0x10, 1 << 7);
    apu.write16(0x12, 2 << 13); // 50%
    apu.write16(0x14, 1 << 15);
    apu.tick(1);
    expect(apu.ch3.sample()).toBe(15 >> 1);
  });

  it("position advances by 1 every (2048 - freq) * 8 cycles", () => {
    const apu = new Apu();
    enable(apu);
    writeWaveRam(apu, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    apu.write16(0x10, 1 << 7);
    apu.write16(0x12, 1 << 13);
    apu.write16(0x14, (1 << 15) | 2040); // freq=2040 → 8 * 8 = 64 cycles/step
    const start = apu.ch3.position;
    apu.tick(64);
    expect(apu.ch3.position).toBe((start + 1) % 32);
  });
});

describe("Apu — PSG channel 4 (noise / LFSR)", () => {
  function enable(apu: Apu): void {
    apu.write16(0x24, 0x0080);
  }

  it("trigger starts the channel and sets the status bit", () => {
    const apu = new Apu();
    enable(apu);
    apu.write16(0x18, (0xf << 12) | 0); // envelope full
    apu.write16(0x1c, 1 << 15); // trigger
    apu.tick(1);
    expect(apu.ch4.enabled).toBe(true);
    expect(apu.read16(0x24) & 0x08).toBe(0x08); // status bits synced on read
  });

  it("LFSR produces deterministic non-constant output", () => {
    const apu = new Apu();
    enable(apu);
    apu.write16(0x18, (0xf << 12) | 0);
    apu.write16(0x1c, (1 << 15) | 0); // trigger, ratio=0, shift=0 → period 8
    const samples = new Set<number>();
    for (let i = 0; i < 100; i++) {
      apu.tick(8);
      samples.add(apu.ch4.sample());
    }
    // LFSR cycles through > 1 distinct value (both polarities).
    expect(samples.size).toBe(2);
    expect(samples.has(15)).toBe(true);
    expect(samples.has(-15)).toBe(true);
  });

  it("envelope decays the noise volume", () => {
    const apu = new Apu();
    enable(apu);
    // Envelope: init vol = 0xF, direction = down, period = 1.
    apu.write16(0x18, (0xf << 12) | (0 << 11) | (1 << 8));
    apu.write16(0x1c, 1 << 15);
    expect(apu.ch4.volume).toBe(0xf);
    for (let i = 0; i < 16; i++) apu.tick(32768);
    expect(apu.ch4.volume).toBeLessThan(0xf);
  });

  it("7-bit narrow mode produces a shorter LFSR cycle (127 vs 32767 states)", () => {
    const apu = new Apu();
    enable(apu);
    apu.write16(0x18, (0xf << 12) | 0);
    // Trigger with narrow-mode bit 3 set.
    apu.write16(0x1c, (1 << 15) | (1 << 3));
    apu.tick(1);
    // After 127 periods, the LFSR should return to its post-trigger state
    // (in narrow mode). At ratio=0, shift=0 → period 8 cycles.
    const initialLfsr = apu.ch4.sample();
    apu.tick(127 * 8);
    expect(apu.ch4.sample()).toBe(initialLfsr);
  });
});

describe("Apu — mixer + stereo output", () => {
  function enableAndTriggerCh1(apu: Apu): void {
    apu.write16(0x24, 0x0080); // master enable
    apu.write16(0x02, (0xf << 12) | (2 << 6)); // envelope full, duty 50%
    apu.write16(0x04, (1 << 15) | 1024); // trigger at midrange freq
  }

  it("only enabled side (L/R) receives the channel sample", () => {
    const apu = new Apu();
    enableAndTriggerCh1(apu);
    // SOUNDCNT_L: ch1 enabled on LEFT only (bit 12), master vol 7 on both.
    apu.write16(0x20, (1 << 12) | (7 << 4) | 7);
    apu.tick(1);
    const stereo = apu.sampleStereo();
    expect(stereo.left).not.toBe(0);
    expect(stereo.right).toBe(0);
  });

  it("PSG volume scaler bits 0-1 of SOUNDCNT_H attenuate the output", () => {
    const apu = new Apu();
    enableAndTriggerCh1(apu);
    apu.write16(0x20, (1 << 12) | (1 << 8) | (7 << 4) | 7); // both sides on
    apu.write16(0x22, 0x0002); // PSG scaler = 100%
    apu.tick(1);
    const full = Math.abs(apu.sampleStereo().left);
    apu.write16(0x22, 0x0000); // PSG scaler = 25%
    const quarter = Math.abs(apu.sampleStereo().left);
    // Quarter is half of full (we shift the 0x0010 25% by >> 2 vs >> 0).
    expect(quarter).toBeLessThan(full);
  });

  it("samples land in outLeft / outRight at the configured rate", () => {
    const apu = new Apu();
    apu.sampleRate = 32768;
    enableAndTriggerCh1(apu);
    apu.write16(0x20, (1 << 12) | (1 << 8) | (7 << 4) | 7);
    apu.write16(0x22, 0x0002);
    // 512 cycles at 16.78 MHz = exactly 1 sample at 32768 Hz.
    apu.tick(512);
    expect(apu.outPos).toBe(1);
    expect(apu.outLeft[0]).not.toBe(0);
  });

  it("master-disable emits silent samples instead of dropping the clock", () => {
    const apu = new Apu();
    apu.sampleRate = 32768;
    apu.tick(512 * 4);
    expect(apu.outPos).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(apu.outLeft[i]).toBe(0);
      expect(apu.outRight[i]).toBe(0);
    }
  });
});

describe("Apu — Direct Sound FIFOs (Phase 5f)", () => {
  function enableMaster(apu: Apu): void {
    apu.write16(0x24, 0x0080);
  }

  it("fifoARequest fires when the FIFO drops below the 16-sample half-full mark", () => {
    // Real hardware refills via a 4-word (16-byte) DMA burst when the
    // FIFO is at or below half-full. A 32-byte FIFO + 16-byte burst
    // = the burst exactly tops the FIFO back up, with no overflow.
    // This watermark is load-bearing for commercial-game audio (every
    // ROM that uses DirectSound).
    const apu = new Apu();
    enableMaster(apu);
    apu.write16(0x22, (1 << 9) | (1 << 8) | (1 << 2));
    // Fill the FIFO to capacity (8 words = 32 samples).
    for (let i = 0; i < 8; i++) apu.write32(0x40, 0);
    expect(apu.fifoA.fill).toBe(32);
    expect(apu.fifoARequest).toBe(false);
    // Drain to 17 → still above watermark.
    for (let i = 0; i < 15; i++) apu.onTimerOverflow(0);
    expect(apu.fifoA.fill).toBe(17);
    expect(apu.fifoARequest).toBe(false);
    // One more pop crosses to 16 → request fires.
    apu.onTimerOverflow(0);
    expect(apu.fifoA.fill).toBe(16);
    expect(apu.fifoARequest).toBe(true);
  });

  it("timer overflow pops a sample from FIFO_A and latches it", () => {
    const apu = new Apu();
    enableMaster(apu);
    // SOUNDCNT_H: DSA timer = 0 (default), DSA enables both sides at 100%.
    apu.write16(0x22, (1 << 9) | (1 << 8) | (1 << 2));
    apu.write32(0x40, 0x7f405020); // 4 samples: 0x20, 0x50, 0x40, 0x7f
    expect(apu.fifoA.fill).toBe(4);

    apu.onTimerOverflow(0);
    expect(apu.fifoA.fill).toBe(3);
    let stereo = apu.sampleStereo();
    expect(stereo.left).toBeGreaterThan(0);
    expect(stereo.right).toBeGreaterThan(0);

    apu.onTimerOverflow(0);
    apu.onTimerOverflow(0);
    apu.onTimerOverflow(0);
    expect(apu.fifoA.fill).toBe(0);
    stereo = apu.sampleStereo();
    // Final pop was 0x7f — the largest positive sample.
    expect(stereo.left).toBeGreaterThan(0);
  });

  it("each DS channel responds only to its selected timer", () => {
    const apu = new Apu();
    enableMaster(apu);
    // DSA timer = 0, DSB timer = 1.
    apu.write16(0x22, (1 << 14) | (1 << 8) | (1 << 12) | (1 << 2) | (1 << 3));
    apu.write32(0x40, 0x01010101); // FIFO_A
    apu.write32(0x44, 0x02020202); // FIFO_B
    apu.onTimerOverflow(0);
    expect(apu.fifoA.fill).toBe(3); // A drained
    expect(apu.fifoB.fill).toBe(4); // B untouched
    apu.onTimerOverflow(1);
    expect(apu.fifoA.fill).toBe(3); // A still 3
    expect(apu.fifoB.fill).toBe(3); // B drained
  });

  it("DSA L/R enable bits route the held sample to the correct side", () => {
    const apu = new Apu();
    enableMaster(apu);
    // SOUNDCNT_H: DSA enable LEFT only (bit 9 set, bit 8 clear), 100% volume.
    apu.write16(0x22, (1 << 9) | (1 << 2));
    apu.write32(0x40, 0x7f7f7f7f);
    apu.onTimerOverflow(0);
    const stereo = apu.sampleStereo();
    expect(stereo.left).toBeGreaterThan(0);
    expect(stereo.right).toBe(0);
  });

  it("DSA volume bit halves the contribution when clear", () => {
    const apu = new Apu();
    enableMaster(apu);
    // Both sides on, 100% volume.
    apu.write16(0x22, (1 << 9) | (1 << 8) | (1 << 2));
    apu.write32(0x40, 0x7f7f7f7f);
    apu.onTimerOverflow(0);
    const full = apu.sampleStereo().left;
    // Same sample held, switch volume to 50%.
    apu.write16(0x22, (1 << 9) | (1 << 8));
    const half = apu.sampleStereo().left;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });

  it("SOUNDCNT_H bit 11 resets FIFO_A and self-clears", () => {
    const apu = new Apu();
    enableMaster(apu);
    apu.write32(0x40, 0x12345678);
    expect(apu.fifoA.fill).toBe(4);
    apu.write16(0x22, 1 << 11); // FIFO_A reset
    expect(apu.fifoA.fill).toBe(0);
    expect(apu.read16(0x22) & (1 << 11)).toBe(0); // self-clearing
  });

  it("SOUNDCNT_H bit 15 resets FIFO_B and self-clears", () => {
    const apu = new Apu();
    enableMaster(apu);
    apu.write32(0x44, 0x12345678);
    expect(apu.fifoB.fill).toBe(4);
    apu.write16(0x22, 1 << 15);
    expect(apu.fifoB.fill).toBe(0);
    expect(apu.read16(0x22) & (1 << 15)).toBe(0);
  });

  it("fifoARequest / fifoBRequest flag low-water mark for DMA refill", () => {
    // Watermark is half-full (16 of 32) — matches the 4-word DMA
    // burst size so refill exactly tops the FIFO back up.
    const apu = new Apu();
    expect(apu.fifoARequest).toBe(true); // empty
    // Fill to 16 samples (= half-full) via 4 word pushes.
    for (let i = 0; i < 4; i++) apu.write32(0x40, 0);
    expect(apu.fifoA.fill).toBe(16);
    expect(apu.fifoARequest).toBe(true); // still at watermark
    apu.write32(0x40, 0); // 20 samples — above watermark
    expect(apu.fifoARequest).toBe(false);
    apu.fifoA.pop(); // 19
    apu.fifoA.pop(); // 18
    apu.fifoA.pop(); // 17
    expect(apu.fifoARequest).toBe(false);
    apu.fifoA.pop(); // 16 — back at watermark
    expect(apu.fifoARequest).toBe(true);
  });

  it("timer overflow is ignored when master enable is off", () => {
    const apu = new Apu();
    // Don't enable master.
    apu.write32(0x40, 0x01020304);
    apu.onTimerOverflow(0);
    expect(apu.fifoA.fill).toBe(4); // unchanged
  });
});

describe("Apu — master enable holds channels in reset", () => {
  it("tick() is a no-op when SOUNDCNT_X.master_enable is clear", () => {
    const apu = new Apu();
    // Trigger ch1 first (writes are accepted regardless of master, but
    // tick must not advance until master is on).
    apu.write16(0x02, (0xf << 12) | (2 << 6));
    apu.write16(0x04, 1 << 15);
    const startPos = apu.ch1.dutyPosition;
    apu.tick(1024);
    expect(apu.ch1.dutyPosition).toBe(startPos); // unchanged — master off
  });
});

describe("MappedBus + APU wiring", () => {
  it("CPU writes to 0x04000060 reach the APU's SOUND1CNT_L", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000060, 0xabcd);
    expect(mem.apu.psg[0]!.cntL).toBe(0xabcd);
  });

  it("APU and PPU register spaces don't overlap — PPU writes don't bleed into APU", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000000, 0xffff); // DISPCNT
    expect(mem.apu.psg[0]!.cntL).toBe(0);
    expect(mem.ppu.dispcnt).toBe(0xffff);
  });

  it("CPU 32-bit push to 0x040000A0 feeds FIFO_A", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write32(0x040000a0, 0x01020304);
    expect(mem.apu.fifoA.fill).toBe(4);
  });
});
