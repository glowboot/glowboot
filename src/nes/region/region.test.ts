import { describe, expect, it } from "vitest";

import type { NesRom } from "../cartridge/rom.js";
import { parseNesRom } from "../cartridge/rom.js";
import { Nes } from "../nes.js";
import { REGION_TIMING } from "./region.js";

/** Minimal mapper-0 cart whose reset vector lands on a `JMP $8000` spin, so
 *  the CPU stays alive while the PPU clocks out whole frames. */
function spinRom(region: "ntsc" | "pal" = "ntsc"): NesRom {
  const prgRom = new Uint8Array(0x4000).fill(0xea); // NOP fill
  prgRom[0x0000] = 0x4c; // JMP $8000
  prgRom[0x0001] = 0x00;
  prgRom[0x0002] = 0x80;
  prgRom[0x3ffc] = 0x00; // reset vector low  → $8000
  prgRom[0x3ffd] = 0x80; // reset vector high
  return {
    prgRom,
    chrRom: new Uint8Array(0),
    usesChrRam: true,
    chrRamSize: 0x2000,
    prgRamSize: 0x2000,
    prgNvramSize: 0,
    mapper: 0,
    submapper: 0,
    mirroring: "horizontal",
    battery: false,
    region,
    nes2: false
  };
}

/** Build a 16-byte iNES header (+ minimal PRG/CHR) with the region flags set,
 *  to exercise the parser's TV-system detection in both header dialects. */
function inesWithRegion(opts: { nes2: boolean; ntsc: boolean }): Uint8Array {
  const data = new Uint8Array(16 + 0x4000 + 0x2000);
  data.set([0x4e, 0x45, 0x53, 0x1a]); // "NES\x1A"
  data[4] = 1; // 1 × 16 KiB PRG
  data[5] = 1; // 1 × 8 KiB CHR
  if (opts.nes2) {
    data[7] = 0x08; // flags7 bits 2-3 = 0b10 → NES 2.0
    data[12] = opts.ntsc ? 0 : 1; // byte 12 region: 0 NTSC, 1 PAL
  } else {
    data[9] = opts.ntsc ? 0 : 1; // iNES byte 9 bit 0: 0 NTSC, 1 PAL
  }
  return data;
}

describe("region timing tables", () => {
  it("encodes the NESdev NTSC / PAL clock + frame rates", () => {
    expect(REGION_TIMING.ntsc.cpuClockHz).toBe(1_789_773);
    expect(REGION_TIMING.ntsc.framesPerSec).toBeCloseTo(60.0988, 4);
    expect(REGION_TIMING.ntsc.preRenderScanline).toBe(261);
    expect(REGION_TIMING.ntsc.oddFrameSkip).toBe(true);

    expect(REGION_TIMING.pal.cpuClockHz).toBe(1_662_607);
    expect(REGION_TIMING.pal.framesPerSec).toBeCloseTo(50.007, 3);
    expect(REGION_TIMING.pal.preRenderScanline).toBe(311);
    expect(REGION_TIMING.pal.oddFrameSkip).toBe(false);
  });
});

describe("ROM region detection", () => {
  it("reads the iNES 1.0 byte-9 TV-system bit", () => {
    expect(parseNesRom(inesWithRegion({ nes2: false, ntsc: true })).region).toBe("ntsc");
    expect(parseNesRom(inesWithRegion({ nes2: false, ntsc: false })).region).toBe("pal");
  });
  it("reads the NES 2.0 byte-12 region field", () => {
    expect(parseNesRom(inesWithRegion({ nes2: true, ntsc: true })).region).toBe("ntsc");
    expect(parseNesRom(inesWithRegion({ nes2: true, ntsc: false })).region).toBe("pal");
  });
});

describe("Nes regional timing is real-time", () => {
  // cycles/frame × fps must reproduce the region's CPU clock, and the audio
  // sample count must reproduce the host rate — otherwise the cart runs fast
  // or slow (the PAL-on-NTSC ~17% speed-up this whole feature fixes).
  for (const region of ["ntsc", "pal"] as const) {
    it(`${region}: CPU + audio rates match the region clock`, () => {
      const t = REGION_TIMING[region];
      const nes = new Nes(spinRom(), region);
      nes.apu.sampleRate = 48000;
      let samples = 0;
      nes.onAudioFrame = (_l, _r, count) => {
        samples += count;
      };
      const N = 300;
      let cycles = 0;
      for (let i = 0; i < N; i++) cycles += nes.runFrame();

      expect(nes.region).toBe(region);
      expect(nes.framesPerSec).toBeCloseTo(t.framesPerSec, 3);
      // Implied CPU clock within 0.05% of the region's true rate.
      expect((cycles / N) * t.framesPerSec).toBeCloseTo(t.cpuClockHz, -3);
      // Implied output rate within ~0.1% of 48 kHz.
      expect((samples / N) * t.framesPerSec).toBeGreaterThan(48000 * 0.999);
      expect((samples / N) * t.framesPerSec).toBeLessThan(48000 * 1.001);
    });
  }

  it("setRegion retimes a live machine", () => {
    const nes = new Nes(spinRom("ntsc"));
    expect(nes.region).toBe("ntsc");
    expect(nes.framesPerSec).toBeCloseTo(60.0988, 4);
    nes.setRegion("pal");
    expect(nes.region).toBe("pal");
    expect(nes.framesPerSec).toBeCloseTo(50.007, 3);
  });
});
