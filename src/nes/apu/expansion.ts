/**
 * Expansion audio — the contract a cartridge sound chip (VRC6, VRC7, Namco 163,
 * Sunsoft 5B, MMC5) exposes to the 2A03 APU. The APU clocks it once per CPU
 * cycle and sums its {@link output} into the final mix before the DC filter.
 */
export interface ExpansionAudio {
  /** Advance the chip's oscillators by one CPU cycle. */
  clock(): void;
  /** Current analog output, scaled to roughly the 2A03's ~0..1 mix domain. */
  output(): number;
}
