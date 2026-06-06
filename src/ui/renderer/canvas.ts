import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../gb";
import type { ColorGrade } from "./shaders.js";
import { TemporalBlender } from "./temporal.js";

/**
 * Renders a framebuffer to an HTML `<canvas>` element via plain
 * `putImageData`. Shares the `TemporalBlender` with the WebGL
 * renderer so both paths respect the Pixel-response slider uniformly.
 *
 * Resolution-parameterised: the constructor takes `inputWidth` /
 * `inputHeight` (defaulting to the Game Boy's 160×144) so the same
 * class serves Game Boy carts and GBA carts (240×160) without a
 * second renderer implementation. The canvas backing buffer is sized
 * to the framebuffer dimensions; CSS scales it to whatever the
 * surrounding `.canvas-wrap` exposes.
 *
 * Visual knobs (see the Settings popover wiring for user-facing controls):
 *  - **Integer scaling**: sizes the canvas to the largest whole-number
 *    multiple of input-w × input-h that fits its container so every
 *    on-screen pixel covers the same number of source pixels.
 *  - **Pixel response**: temporal blend applied before the blit (see
 *    `TemporalBlender`). 0 = off, higher = slower LCD.
 *
 * Heavier visual effects (LCD handheld, xBR upscaling, CRT, etc.) live
 * in `webgl.ts`; this class is deliberately the "plain / fast" path.
 */

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;
  private readonly inputWidth: number;
  private readonly inputHeight: number;

  private _integerScale = false;
  private resizeObserver: ResizeObserver | null = null;

  private readonly blender: TemporalBlender;

  /** Current-frame weight for the temporal blend — 1.0 = off. Stored
   *  pre-converted (slider "response strength" becomes α = 1 − strength)
   *  so the render hot path doesn't branch or recompute. */
  private blendAlpha = 1;

  constructor(canvas: HTMLCanvasElement, inputWidth: number = SCREEN_WIDTH, inputHeight: number = SCREEN_HEIGHT) {
    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;
    canvas.width = inputWidth;
    canvas.height = inputHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D context from canvas");
    this.canvas = canvas;
    this.ctx = ctx;
    this.blender = new TemporalBlender(inputWidth * inputHeight * 4);
  }

  render(framebuffer: Uint8ClampedArray<ArrayBuffer>): void {
    const src = this.blender.apply(framebuffer, this.blendAlpha);
    if (!this.imageData || this.imageData.data !== src) {
      this.imageData = new ImageData(src, this.inputWidth, this.inputHeight);
    }
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  // ─── Integer scaling ──────────────────────────────────────────────────────

  get integerScale(): boolean {
    return this._integerScale;
  }

  set integerScale(enabled: boolean) {
    if (this._integerScale === enabled) return;
    this._integerScale = enabled;
    if (enabled) {
      this.applyIntegerScale();
      this.resizeObserver = new ResizeObserver(() => this.applyIntegerScale());
      const parent = this.canvas.parentElement;
      if (parent) this.resizeObserver.observe(parent);
    } else {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.canvas.style.width = "";
      this.canvas.style.height = "";
    }
  }

  private applyIntegerScale(): void {
    // Skip integer-scale sizing whenever the canvas is inside the
    // fullscreen element — the fullscreen wrapper (`.console`) takes
    // over layout and the ResizeObserver would otherwise fight its
    // sizing rules.
    if (document.fullscreenElement?.contains(this.canvas)) {
      this.canvas.style.width = "";
      this.canvas.style.height = "";
      return;
    }
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const availW = parent.clientWidth;
    const availH = parent.clientHeight;
    const scale = Math.max(
      1,
      Math.min(Math.floor(availW / this.canvas.width), Math.floor(availH / this.canvas.height))
    );
    this.canvas.style.width = `${scale * this.canvas.width}px`;
    this.canvas.style.height = `${scale * this.canvas.height}px`;
  }

  // ─── Pixel response ───────────────────────────────────────────────────────
  // A number in [0, 1) where 0 disables the blend (each frame overwrites the
  // previous) and higher values stretch the response curve — 0.5 matches
  // the classic 50/50 "LCD ghosting" behaviour, 0.8 is heavy smear.

  setPixelResponse(strength: number): void {
    const s = Math.max(0, Math.min(0.95, strength));
    this.blendAlpha = 1 - s;
    if (s === 0) this.blender.reset();
  }

  /** Colour grading is WebGL-only. This no-op keeps the two renderer
   *  classes duck-type compatible so the host doesn't have to branch. */
  setColorGrade(_g: ColorGrade): void {
    /* no-op on Canvas 2D */
  }

  /** Match WebGLRenderer's dispose contract so `swapRenderer` can drop
   *  the outgoing instance without branching on backend. The 2D path
   *  only owns a ResizeObserver edge worth detaching — everything else
   *  is GC'd once the renderer becomes unreachable. */
  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }
}
