import { beforeEach, describe, expect, it } from "vitest";

import { APU } from "./apu.js";

describe("APU top-level", () => {
  let apu: APU;

  beforeEach(() => {
    apu = new APU();
    // Power the APU on so writes to channel registers are accepted.
    apu.writeByte(0xff26, 0x80);
  });

  describe("NR52 (power + status)", () => {
    it("comes up powered on (post-boot state), all channel-status bits clear", () => {
      const fresh = new APU();
      // Post-boot NR52 = 0xF1: bit 7 power on, bits 4-6 unused (read 1), bits
      // 0-3 channel-status (all 0 with no channels triggered yet).
      expect(fresh.readByte(0xff26) & 0x80).toBe(0x80);
      expect(fresh.readByte(0xff26) & 0x0f).toBe(0);
    });

    it("remains writable while powered off (only NR52 and wave-RAM accept writes)", () => {
      apu.writeByte(0xff26, 0x00); // power off
      apu.writeByte(0xff11, 0x80); // attempt to write NR11 while off
      apu.writeByte(0xff26, 0x80); // power back on
      // Before the power cycle, NR11 would have been set to 0x80, but the
      // power-off should have blocked it. Re-read via the channel to confirm.
      // (NR11 reads back as (nr1 | 0x3F); after powerOff() clears all fields,
      //  it's 0x3F.)
      expect(apu.readByte(0xff11)).toBe(0x3f);
    });

    it("reports channel status bits 0-3 when a channel is on", () => {
      apu.writeByte(0xff12, 0xf0); // CH1 NR12: DAC on
      apu.writeByte(0xff14, 0x80); // CH1 trigger
      expect(apu.readByte(0xff26) & 0x01).toBe(0x01);
    });
  });

  describe("wave RAM access via readByte/writeByte (0xFF30–0xFF3F)", () => {
    it("direct read/write when CH3 is inactive", () => {
      apu.writeByte(0xff30, 0xab);
      expect(apu.readByte(0xff30)).toBe(0xab);
    });

    it("while CH3 is active, reads redirect to the currently-playing byte", () => {
      // Populate wave RAM with a known pattern.
      for (let i = 0; i < 16; i++) apu.writeByte(0xff30 + i, i);
      // Turn on CH3: DAC on, trigger, highest freq → wave unit active.
      apu.writeByte(0xff1a, 0x80); // NR30 DAC on
      apu.writeByte(0xff1d, 0xff); // NR33 freq low
      apu.writeByte(0xff1e, 0x87); // NR34 trigger + freqHi=7

      // Immediately after trigger currentByteIndex = 0, so ANY $FF3x read
      // should return waveRam[0] = 0x00.
      expect(apu.readByte(0xff31)).toBe(0);
      expect(apu.readByte(0xff35)).toBe(0);
    });
  });

  describe("I/O routing", () => {
    it("NR50 (0xFF24) round-trips through the APU bus", () => {
      apu.writeByte(0xff24, 0x77);
      expect(apu.readByte(0xff24)).toBe(0x77);
    });

    it("NR51 (0xFF25) round-trips through the APU bus", () => {
      apu.writeByte(0xff25, 0xf3);
      expect(apu.readByte(0xff25)).toBe(0xf3);
    });

    it("returns 0xFF for addresses outside the APU's range", () => {
      expect(apu.readByte(0xff10 - 1)).toBe(0xff);
      expect(apu.readByte(0xff40)).toBe(0xff);
    });
  });

  describe("tick() while powered off is a no-op", () => {
    it("does not produce samples while APU is off", () => {
      apu.writeByte(0xff26, 0x00); // off
      apu.tick(1000);
      expect(apu.outPos).toBe(0);
    });
  });
});
