/**
 * NES regional timing — NTSC (North America / Japan, RP2A03/2C02) vs PAL
 * (Europe / Australia, RP2A07/2C07). The two consoles differ in master-clock
 * divider, scanline count, the APU frame-sequencer periods, and the noise /
 * DMC period tables, which together make a PAL game run ~17% slower (50.0070
 * vs 60.0988 Hz). A cart authored for one region runs at the wrong speed on
 * the other — the common "(E) ROM plays too fast" symptom.
 *
 * Ported from https://www.nesdev.org/wiki/Cycle_reference_chart,
 * /APU_Frame_Counter, /APU_Noise and /APU_DMC.
 */

export type Region = "ntsc" | "pal";

export interface RegionTiming {
  region: Region;
  /** CPU (2A03 / 2A07) clock in Hz — master / 12 (NTSC) or master / 16 (PAL). */
  cpuClockHz: number;
  /** Frame rate used by the host pacer. */
  framesPerSec: number;
  /** PPU dots per CPU cycle: 3 (NTSC, master/4 over master/12) or 3.2 (PAL,
   *  master/5 over master/16). PAL's non-integer ratio is carried as a
   *  fractional accumulator. */
  ppuDotsPerCpuCycle: number;
  /** Pre-render (last) scanline index — 261 for NTSC's 262 lines, 311 for
   *  PAL's 312. */
  preRenderScanline: number;
  /** NTSC drops the pre-render line's final dot on odd frames while rendering;
   *  PAL never does. */
  oddFrameSkip: boolean;
  /** APU 4-step frame-sequencer boundaries in CPU cycles: the three quarter /
   *  half clock points, the quarter+half+IRQ point, and the wrap. */
  apuFrameSeq4: readonly [number, number, number, number, number];
  /** APU 5-step boundaries: quarter, quarter+half, quarter, quarter+half, wrap
   *  (no IRQ; the sequence is one step longer than 4-step). */
  apuFrameSeq5: readonly [number, number, number, number, number];
  /** Noise channel timer periods (CPU cycles), indexed by $400E low nibble. */
  noisePeriods: readonly number[];
  /** DMC output-clock periods (CPU cycles), indexed by $4010 low nibble. */
  dmcRates: readonly number[];
}

// prettier-ignore
const NTSC: RegionTiming = {
  region: "ntsc",
  cpuClockHz: 1_789_773,
  framesPerSec: 60.0988,
  ppuDotsPerCpuCycle: 3,
  preRenderScanline: 261,
  oddFrameSkip: true,
  apuFrameSeq4: [7457, 14913, 22371, 29829, 29830],
  apuFrameSeq5: [7457, 14913, 22371, 37281, 37282],
  noisePeriods: [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068],
  dmcRates: [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54]
};

// prettier-ignore
const PAL: RegionTiming = {
  region: "pal",
  cpuClockHz: 1_662_607,
  framesPerSec: 50.0070,
  ppuDotsPerCpuCycle: 3.2,
  preRenderScanline: 311,
  oddFrameSkip: false,
  apuFrameSeq4: [8313, 16627, 24939, 33253, 33254],
  apuFrameSeq5: [8313, 16627, 24939, 41565, 41566],
  noisePeriods: [4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778],
  dmcRates: [398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50]
};

export const REGION_TIMING: Record<Region, RegionTiming> = { ntsc: NTSC, pal: PAL };
