import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../gb";
import {
  type ColorGrade,
  DEFAULT_COLOR_GRADE,
  FRAG_BY_NAME,
  GRADE_IDENTITY_SNIPPET,
  GRADE_SNIPPET,
  type ShaderName,
  VERT_SRC
} from "./shaders.js";
import { TemporalBlender } from "./temporal.js";

/**
 * WebGL renderer. Takes the PPU framebuffer through a configurable
 * single- or multi-pass fragment shader chain defined in `./shaders.ts`.
 *
 * Resolution-parameterised (like `./canvas.ts`): the constructor takes
 * an explicit `inputWidth` / `inputHeight` defaulting to the Game
 * Boy's 160×144, so the same renderer serves Game Boy carts and Game
 * Boy Advance carts (240×160). FBO and source-size uniforms scale
 * accordingly.
 *
 *   - Single-pass modes (LCD, xBR, CRT, …) render straight to the
 *     canvas.
 *   - Multi-pass modes (Super-xBR) render pass 0 into a 2×-native FBO,
 *     and subsequent passes sample that texture. Only the final pass
 *     writes to the canvas.
 *
 * The temporal-response blend lives on the CPU (shared with the Canvas
 * 2D renderer via `TemporalBlender`) and runs before the texture upload
 * so every shader sees the already-blended source.
 *
 * Colour grading is a per-fragment transform injected as the final step
 * of the chain — `GRADE_SNIPPET` on the last pass, `GRADE_IDENTITY_SNIPPET`
 * on intermediates so their `colorGrade()` calls compile without
 * actually touching the pixels (prevents cumulative re-grading).
 */

/** Per-pass render state. Every pass has its own compiled program and a
 *  cached location for uSourceSize (which describes the pass's INPUT
 *  texture, not "source of source"). Grading uniform locations are only
 *  non-null on the last pass since earlier passes get the identity
 *  stub. */
interface PassState {
  program: WebGLProgram;
  uSourceSize: WebGLUniformLocation | null;
  inputWidth: number;
  inputHeight: number;
}

/** Intermediate resolution multiplier for multi-pass upscalers. 2× the
 *  input resolution produces a working texture that the final pass
 *  samples and outputs to the 6×-input canvas with linear filtering. */
const INTERMEDIATE_SCALE = 2;

export class WebGLRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly passes: PassState[];
  private readonly texture: WebGLTexture;
  private readonly inputWidth: number;
  private readonly inputHeight: number;
  private readonly intermediateWidth: number;
  private readonly intermediateHeight: number;

  /** FBO + backing texture for multi-pass rendering. Null for single-
   *  pass shaders. */
  private readonly intermediateFbo: WebGLFramebuffer | null;
  private readonly intermediateTexture: WebGLTexture | null;
  private readonly gradeUniforms: {
    brightness: WebGLUniformLocation | null;
    contrast: WebGLUniformLocation | null;
    gamma: WebGLUniformLocation | null;
    saturation: WebGLUniformLocation | null;
    temperature: WebGLUniformLocation | null;
  };
  private _integerScale = false;
  private resizeObserver: ResizeObserver | null = null;
  private readonly blender: TemporalBlender;
  private blendAlpha = 1;

  /** Which shader this renderer is running. Used by the cart-overrides
   *  flow to decide whether a render-mode change needs a `swapRenderer`
   *  (which destroys the canvas) or is already a match. */
  readonly shaderName: ShaderName;

  constructor(
    canvas: HTMLCanvasElement,
    shader: ShaderName = "lcd",
    inputWidth: number = SCREEN_WIDTH,
    inputHeight: number = SCREEN_HEIGHT
  ) {
    this.canvas = canvas;
    this.shaderName = shader;
    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;
    this.intermediateWidth = inputWidth * INTERMEDIATE_SCALE;
    this.intermediateHeight = inputHeight * INTERMEDIATE_SCALE;
    this.blender = new TemporalBlender(inputWidth * inputHeight * 4);
    // Pick a backing-store size high enough that the shader has detail
    // to render its LCD cell grid, even when the container CSS-scales
    // the canvas down. 6× input gives plenty of headroom.
    canvas.width = inputWidth * 6;
    canvas.height = inputHeight * 6;

    const gl = canvas.getContext("webgl", {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true // so canvas.toDataURL() screenshots still work
    });
    if (!gl) throw new Error("WebGL not available");
    this.gl = gl;

    // Flip uploaded source data to match WebGL's bottom-up texture
    // convention. With this set, the vertex shader can skip its own
    // flip and intermediate FBOs stay in the same orientation —
    // otherwise multi-pass chains end up displaying upside-down after
    // round-tripping through an FBO.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // Resolve the shader into a pass chain. Single-string modes become a
    // one-element chain (no FBO needed); array modes stay as-is.
    const entry = FRAG_BY_NAME[shader];
    const bodies: string[] = Array.isArray(entry) ? entry : [entry];
    const isMultiPass = bodies.length > 1;

    // Full-screen quad shared by every pass.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);

    // Compile each pass. Only the last pass gets the real grading
    // snippet — intermediates use the identity stub so their call to
    // colorGrade() compiles but doesn't touch the pixels (prevents
    // cumulative double-grading when the chain reads its own output).
    this.passes = bodies.map((body, i) => {
      const isLast = i === bodies.length - 1;
      const snippet = isLast ? GRADE_SNIPPET : GRADE_IDENTITY_SNIPPET;
      const fragSrc = body.replace("void main()", `${snippet}\nvoid main()`);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
      const program = gl.createProgram();
      if (!program) throw new Error("WebGL program alloc failed");
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? "WebGL link failed");
      }
      gl.useProgram(program);
      const aPos = gl.getAttribLocation(program, "aPos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(gl.getUniformLocation(program, "uFrame"), 0);
      const passInputWidth = i === 0 ? this.inputWidth : this.intermediateWidth;
      const passInputHeight = i === 0 ? this.inputHeight : this.intermediateHeight;
      return {
        program,
        uSourceSize: gl.getUniformLocation(program, "uSourceSize"),
        inputWidth: passInputWidth,
        inputHeight: passInputHeight
      };
    });

    // Grading uniforms live on the last pass's program (the only one
    // that has the full GRADE_SNIPPET).
    const lastProgram = this.passes[this.passes.length - 1]!.program;
    gl.useProgram(lastProgram);
    this.gradeUniforms = {
      brightness: gl.getUniformLocation(lastProgram, "uBrightness"),
      contrast: gl.getUniformLocation(lastProgram, "uContrast"),
      gamma: gl.getUniformLocation(lastProgram, "uGamma"),
      saturation: gl.getUniformLocation(lastProgram, "uSaturation"),
      temperature: gl.getUniformLocation(lastProgram, "uTemperature")
    };
    this.setColorGrade(DEFAULT_COLOR_GRADE);

    // Source texture — receives the engine framebuffer upload each frame.
    const tex = gl.createTexture();
    if (!tex) throw new Error("WebGL texture alloc failed");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = tex;

    // Intermediate FBO for multi-pass.
    if (isMultiPass) {
      const iTex = gl.createTexture();
      if (!iTex) throw new Error("WebGL intermediate texture alloc failed");
      gl.bindTexture(gl.TEXTURE_2D, iTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.intermediateWidth,
        this.intermediateHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error("WebGL FBO alloc failed");
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, iTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("WebGL FBO incomplete");
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.intermediateFbo = fbo;
      this.intermediateTexture = iTex;
    } else {
      this.intermediateFbo = null;
      this.intermediateTexture = null;
    }
  }

  render(framebuffer: Uint8ClampedArray<ArrayBuffer>): void {
    const src = this.blender.apply(framebuffer, this.blendAlpha);
    const gl = this.gl;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.inputWidth, this.inputHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);

    for (let i = 0; i < this.passes.length; i++) {
      const pass = this.passes[i]!;
      const isLast = i === this.passes.length - 1;
      gl.useProgram(pass.program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, i === 0 ? this.texture : this.intermediateTexture!);

      if (pass.uSourceSize) gl.uniform2f(pass.uSourceSize, pass.inputWidth, pass.inputHeight);

      if (isLast) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.intermediateFbo);
        gl.viewport(0, 0, this.intermediateWidth, this.intermediateHeight);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // ─── Integer scaling ─────────────────────────────────────────────────────

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
    // fullscreen element — see canvas.ts for the same rationale.
    if (document.fullscreenElement?.contains(this.canvas)) {
      this.canvas.style.width = "";
      this.canvas.style.height = "";
      return;
    }
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const availW = parent.clientWidth;
    const availH = parent.clientHeight;
    const scale = Math.max(1, Math.min(Math.floor(availW / this.inputWidth), Math.floor(availH / this.inputHeight)));
    this.canvas.style.width = `${scale * this.inputWidth}px`;
    this.canvas.style.height = `${scale * this.inputHeight}px`;
  }

  /** Match CanvasRenderer's temporal-blend contract so the host can
   *  invoke `renderer.setPixelResponse(x)` regardless of which backend
   *  is active. */
  setPixelResponse(strength: number): void {
    const s = Math.max(0, Math.min(0.95, strength));
    this.blendAlpha = 1 - s;
    if (s === 0) this.blender.reset();
  }

  /** Push new colour-grading values to the GPU. Cheap (five uniform1f
   *  calls); the shader reads the uniforms every frame so the effect
   *  shows up on the next draw without any recompile. Grading lives on
   *  the last pass only — intermediate passes have the identity stub. */
  setColorGrade(g: ColorGrade): void {
    const gl = this.gl;
    gl.useProgram(this.passes[this.passes.length - 1]!.program);
    const u = this.gradeUniforms;
    if (u.brightness) gl.uniform1f(u.brightness, g.brightness);
    if (u.contrast) gl.uniform1f(u.contrast, g.contrast);
    if (u.gamma) gl.uniform1f(u.gamma, g.gamma);
    if (u.saturation) gl.uniform1f(u.saturation, g.saturation);
    if (u.temperature) gl.uniform1f(u.temperature, g.temperature);
  }

  /** Free GPU + observer resources held by this renderer. Called by
   *  `swapRenderer` on the outgoing instance — without this, every
   *  render-mode change (and every ROM load that pins a different mode)
   *  leaks a WebGL context, its 960×864 drawing buffer, the compiled
   *  programs / textures / FBO, and the parent-element ResizeObserver
   *  edge that keeps the orphaned canvas reachable. */
  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const gl = this.gl;
    for (const pass of this.passes) gl.deleteProgram(pass.program);
    gl.deleteTexture(this.texture);
    if (this.intermediateTexture) gl.deleteTexture(this.intermediateTexture);
    if (this.intermediateFbo) gl.deleteFramebuffer(this.intermediateFbo);
    // Eagerly drop the GPU context so the browser frees its drawing
    // buffer + driver-side state instead of waiting for the (small)
    // live-context LRU to evict it.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("WebGL shader alloc failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "shader compile failed";
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}
