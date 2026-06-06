/**
 * Per-pixel exponential-decay blend between the current PPU framebuffer
 * and the previous blended output. Produces the "slow LCD" pixel-response
 * look: bright pixels linger slightly as they fade, and 30 Hz flicker
 * (used by many GB games to fake sub-2-bit intensities — Pokémon's
 * transparency, Link's Awakening rain) reads as smooth intermediate
 * shades instead of a strobe. Engine-agnostic — the buffer is sized to
 * whatever framebuffer the caller passes in, so Game Boy Advance carts
 * route through the same blender with their 240×160 frame (the
 * flicker-cancellation use case is GB-specific but the persistence
 * effect still reads as authentic on GBA carts that lean on the LCD's
 * slow response, e.g. F-Zero's mode-7 racers).
 *
 * The output is fed back into the accumulator each frame, so the weight
 * of any given past frame falls off geometrically:
 *
 *   out₀ = α·c₀
 *   out₁ = α·c₁ + (1−α)·out₀       = α·c₁ + α(1−α)·c₀
 *   out₂ = α·c₂ + (1−α)·out₁       = α·c₂ + α(1−α)·c₁ + α(1−α)²·c₀
 *   …
 *
 * α = 1 is identity (no blur), α = 0.5 matches the classic 50/50 ghost,
 * smaller α stretches the tail longer. The host layer maps a 0..1
 * "response strength" slider to α = 1 − strength so the slider reads
 * left-to-right as "off → heavy".
 *
 * Shared by both the Canvas 2D and WebGL render paths: each renderer
 * calls `apply(framebuffer, alpha)` at the top of its `render()` method
 * and uses the returned buffer as the effective source for the rest of
 * the pipeline. That keeps the same temporal behaviour visible
 * regardless of which spatial shader is active downstream.
 */

export class TemporalBlender {
  private prev: Uint8ClampedArray | null = null;
  private out: Uint8ClampedArray<ArrayBuffer> | null = null;
  private readonly len: number;

  constructor(len: number) {
    this.len = len;
  }

  /** Blend `current` with the running accumulator. Returns the same
   *  `current` buffer untouched when alpha ≥ 1 (the "off" fast path).
   *  Allocates internal buffers lazily on first non-identity call. */
  apply(current: Uint8ClampedArray<ArrayBuffer>, alpha: number): Uint8ClampedArray<ArrayBuffer> {
    if (alpha >= 1) return current;
    // alpha ≤ 0 would mean "ignore the new frame entirely" — nonsensical
    // here, so clamp to a small positive value to keep the blender live.
    const a = alpha <= 0 ? 0.05 : alpha;
    if (!this.prev || !this.out) {
      this.prev = new Uint8ClampedArray(this.len);
      this.out = new Uint8ClampedArray(new ArrayBuffer(this.len));
    }
    const prev = this.prev;
    const out = this.out;
    const oneMinusA = 1 - a;
    for (let i = 0; i < this.len; i++) {
      const v = a * current[i]! + oneMinusA * prev[i]!;
      out[i] = v;
      prev[i] = v;
    }
    return out;
  }

  /** Clear the running average — useful on ROM switch so the first frame
   *  of the new game doesn't ghost into the last frame of the previous. */
  reset(): void {
    this.prev?.fill(0);
    this.out?.fill(0);
  }
}
