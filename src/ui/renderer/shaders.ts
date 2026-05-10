/**
 * All shader sources for the WebGL renderer, plus the registry that
 * maps a user-facing mode name to either a single-pass fragment source
 * or a multi-pass chain.
 *
 * Organisation:
 *   - `VERT_SRC`                — shared fullscreen-quad vertex shader.
 *   - `GRADE_SNIPPET`           — colour-grading uniforms + helper,
 *                                 injected before `void main()` on the
 *                                 final pass of every shader chain.
 *   - `GRADE_IDENTITY_SNIPPET`  — no-op stub injected on intermediate
 *                                 passes so `colorGrade()` compiles
 *                                 without re-applying the effect.
 *   - `FRAG_*`                  — fragment sources per mode.
 *   - `ShaderName` + `FRAG_BY_NAME` — the registry.
 *   - `ColorGrade` + `DEFAULT_COLOR_GRADE` — tuning shape passed in
 *                                 from the Settings UI.
 */

export const VERT_SRC = `attribute vec2 aPos;
varying vec2 vUv;
void main() {
  // No Y flip here — the flip lives on the upload side via
  // UNPACK_FLIP_Y_WEBGL, which brings the engine's top-down framebuffer
  // into WebGL's bottom-up convention. That also makes intermediate
  // FBOs usable directly: multi-pass chains that render into an FBO and
  // sample it on the next pass keep a single consistent orientation
  // without needing per-pass vertex variants.
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Shared colour-grading uniforms + helper, injected before `void main()`
 *  in every fragment shader that gets the REAL version. The host updates
 *  the uniforms whenever the user touches the grading sliders — no
 *  pipeline recompile needed.
 *
 *  Operations in order:
 *    1. brightness  — additive offset     [-0.25, +0.25]
 *    2. contrast    — scale around 0.5    [ 0.70, 1.30]
 *    3. gamma       — pow(c, 1/gamma)     [ 0.60, 1.60]
 *    4. saturation  — lerp(luma, c, s)    [ 0.00, 1.50]
 *    5. temperature — R+, B- (warm) or inverse (cool) [-0.15, +0.15] */
export const GRADE_SNIPPET = `uniform float uBrightness;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform float uTemperature;

vec3 colorGrade(vec3 c) {
  c = c + uBrightness;
  c = (c - 0.5) * uContrast + 0.5;
  c = pow(max(c, 0.0), vec3(1.0 / max(uGamma, 0.001)));
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);
  c += vec3(uTemperature, 0.0, -uTemperature);
  return clamp(c, 0.0, 1.0);
}
`;

/** Identity stub for intermediate passes of multi-pass shaders. All
 *  fragment shaders call `colorGrade()` on their final RGB — inserting
 *  this no-op lets the intermediate passes compile with the same source
 *  body, without the grade actually being applied until the final
 *  pass (which gets `GRADE_SNIPPET` instead). Prevents cumulative
 *  regrading when a multi-pass shader chain reads its own output. */
export const GRADE_IDENTITY_SNIPPET = `vec3 colorGrade(vec3 c) { return c; }
`;

// ─── LCD handheld shader ────────────────────────────────────────────────
// Simulates the Game Boy's dot-matrix LCD: each source pixel renders as
// a discrete sub-cell with a soft edge falloff, visible inter-cell gap,
// and subtle curvature shading. See WebGLRenderer doc block for details.
const FRAG_LCD = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

void main() {
  vec2 cell = vUv * uSourceSize;
  vec2 cellId = floor(cell);
  vec2 cellUv = fract(cell);
  vec2 sampleUv = (cellId + 0.5) / uSourceSize;
  vec3 color = texture2D(uFrame, sampleUv).rgb;
  vec2 d = abs(cellUv - 0.5) * 2.0;
  float edge = max(d.x, d.y);
  float cellMask = smoothstep(0.95, 0.72, edge);
  vec3 gap = color * 0.12 + vec3(0.015);
  vec3 lit = mix(gap, color * 0.94, cellMask);
  float cellShade = 0.88 + 0.12 * (1.0 - edge);
  lit *= cellShade;
  gl_FragColor = vec4(colorGrade(lit), 1.0);
}`;

// ─── xBR lv2 upscaler ───────────────────────────────────────────────────
// Port of Hyllian's xBR Level 2 single-pass shader (see the libretro
// glsl-shaders repo). Produces noticeably cleaner diagonals than lv1:
// instead of only checking the immediate 3×3 neighbourhood, lv2 samples
// a diamond-shaped region up to 2 pixels away and uses a weighted
// distance heuristic to confirm that a candidate diagonal edge actually
// *continues* before committing to smoothing it. That rejects stray
// single-pixel patterns that a simpler detector would over-smooth.
//
// Upstream license, retained verbatim as required by its terms:
/*
   Hyllian's xBR-lv2 Shader

   Copyright (C) 2011-2016 Hyllian - sergiogdb@gmail.com

   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:

   The above copyright notice and this permission notice shall be included in
   all copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   THE SOFTWARE.

   Incorporates some of the ideas from SABR shader. Thanks to Joshua Street.
*/
const FRAG_XBR = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float EQ_THRESHOLD = 15.0;

float cdf(vec3 a, vec3 b) {
  vec3 d = abs(a - b) * 255.0;
  return d.r + d.g + d.b;
}

bool eq(vec3 a, vec3 b) {
  return cdf(a, b) < EQ_THRESHOLD;
}

float wd(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, vec3 f, vec3 g, vec3 h) {
  return cdf(a, b) + cdf(a, c) + cdf(d, e) + cdf(d, f) + 4.0 * cdf(g, h);
}

void main() {
  vec2 ps = 1.0 / uSourceSize;
  vec2 pos = vUv * uSourceSize;
  vec2 cellId = floor(pos);
  vec2 sub = fract(pos) - 0.5;
  vec2 tc = (cellId + 0.5) * ps;

  vec3 A = texture2D(uFrame, tc + vec2(-1.0, -1.0) * ps).rgb;
  vec3 B = texture2D(uFrame, tc + vec2( 0.0, -1.0) * ps).rgb;
  vec3 C = texture2D(uFrame, tc + vec2( 1.0, -1.0) * ps).rgb;
  vec3 D = texture2D(uFrame, tc + vec2(-1.0,  0.0) * ps).rgb;
  vec3 E = texture2D(uFrame, tc).rgb;
  vec3 F = texture2D(uFrame, tc + vec2( 1.0,  0.0) * ps).rgb;
  vec3 G = texture2D(uFrame, tc + vec2(-1.0,  1.0) * ps).rgb;
  vec3 H = texture2D(uFrame, tc + vec2( 0.0,  1.0) * ps).rgb;
  vec3 I = texture2D(uFrame, tc + vec2( 1.0,  1.0) * ps).rgb;
  vec3 B1 = texture2D(uFrame, tc + vec2( 0.0, -2.0) * ps).rgb;
  vec3 D0 = texture2D(uFrame, tc + vec2(-2.0,  0.0) * ps).rgb;
  vec3 F4 = texture2D(uFrame, tc + vec2( 2.0,  0.0) * ps).rgb;
  vec3 H5 = texture2D(uFrame, tc + vec2( 0.0,  2.0) * ps).rgb;
  vec3 A0 = texture2D(uFrame, tc + vec2(-2.0, -1.0) * ps).rgb;
  vec3 A1 = texture2D(uFrame, tc + vec2(-1.0, -2.0) * ps).rgb;
  vec3 C1 = texture2D(uFrame, tc + vec2( 1.0, -2.0) * ps).rgb;
  vec3 C4 = texture2D(uFrame, tc + vec2( 2.0, -1.0) * ps).rgb;
  vec3 G0 = texture2D(uFrame, tc + vec2(-2.0,  1.0) * ps).rgb;
  vec3 G5 = texture2D(uFrame, tc + vec2(-1.0,  2.0) * ps).rgb;
  vec3 I4 = texture2D(uFrame, tc + vec2( 2.0,  1.0) * ps).rgb;
  vec3 I5 = texture2D(uFrame, tc + vec2( 1.0,  2.0) * ps).rgb;

  vec3 result = E;

  if (sub.x >= 0.0 && sub.y < 0.0) {
    float wdEdge = wd(E, C, B, F, H, D, C1, A);
    float wdAnti = wd(F, A, B, I, D, C4, H, B1);
    if (wdEdge < wdAnti && !eq(E, B) && !eq(E, F) && !eq(B, D) && !eq(F, H)) {
      float d = sub.x - sub.y;
      result = mix(E, (B + F) * 0.5, smoothstep(0.0, 0.4, d));
    }
  } else if (sub.x < 0.0 && sub.y < 0.0) {
    float wdEdge = wd(E, A, D, B, F, H, A1, C);
    float wdAnti = wd(B, C, A, G, H, A0, F, D0);
    if (wdEdge < wdAnti && !eq(E, B) && !eq(E, D) && !eq(B, F) && !eq(D, H)) {
      float d = -sub.x - sub.y;
      result = mix(E, (B + D) * 0.5, smoothstep(0.0, 0.4, d));
    }
  } else if (sub.x < 0.0 && sub.y >= 0.0) {
    float wdEdge = wd(E, G, H, D, B, F, G5, I);
    float wdAnti = wd(D, I, H, A, B, G0, F, H5);
    if (wdEdge < wdAnti && !eq(E, D) && !eq(E, H) && !eq(D, B) && !eq(H, F)) {
      float d = -sub.x + sub.y;
      result = mix(E, (D + H) * 0.5, smoothstep(0.0, 0.4, d));
    }
  } else {
    float wdEdge = wd(E, I, H, F, D, B, I5, C);
    float wdAnti = wd(H, C, I, G, F, I4, B, H5);
    if (wdEdge < wdAnti && !eq(E, F) && !eq(E, H) && !eq(F, B) && !eq(H, D)) {
      float d = sub.x + sub.y;
      result = mix(E, (F + H) * 0.5, smoothstep(0.0, 0.4, d));
    }
  }

  gl_FragColor = vec4(colorGrade(result), 1.0);
}`;

// ─── CRT shader ─────────────────────────────────────────────────────────
// Classic arcade / SGB-on-CRT look: barrel-distorted UVs, scanline
// dimming at one cycle per source row, RGB aperture-grille mask, cheap
// 5-tap bloom, and corner vignette.
const FRAG_CRT = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 o = abs(uv.yx) / vec2(8.0, 6.0);
  uv = uv + uv * o * o;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = curve(vUv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 cell = uv * uSourceSize;
  vec2 sampleUv = (floor(cell) + 0.5) / uSourceSize;
  vec3 color = texture2D(uFrame, sampleUv).rgb;
  vec2 ps = 1.0 / uSourceSize;
  vec3 bloom = texture2D(uFrame, sampleUv + vec2( ps.x, 0.0)).rgb
             + texture2D(uFrame, sampleUv + vec2(-ps.x, 0.0)).rgb
             + texture2D(uFrame, sampleUv + vec2(0.0,  ps.y)).rgb
             + texture2D(uFrame, sampleUv + vec2(0.0, -ps.y)).rgb;
  color = mix(color, color + bloom * 0.25, 0.3);
  float scan = 0.5 + 0.5 * cos(uv.y * uSourceSize.y * 6.2831853);
  color *= 0.7 + 0.3 * scan;
  float mpos = mod(gl_FragCoord.x, 3.0);
  vec3 mask = vec3(0.9);
  if (mpos < 1.0) mask = vec3(1.12, 0.9, 0.9);
  else if (mpos < 2.0) mask = vec3(0.9, 1.12, 0.9);
  else mask = vec3(0.9, 0.9, 1.12);
  color *= mask;
  vec2 d = (vUv - 0.5) * 2.0;
  float vig = 1.0 - dot(d, d) * 0.32;
  color *= clamp(vig, 0.55, 1.0);
  gl_FragColor = vec4(colorGrade(color), 1.0);
}`;

// ─── DMG pea-soup green shader ──────────────────────────────────────────
// Classic olive-green "original Game Boy" look with hand-tuned colour
// stops — luma-to-4-stop LUT plus a soft cell-grid + faint vertical
// gradient to fake the LCD's panel character.
const FRAG_DMG = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

const vec3 DMG_DARK  = vec3(0.059, 0.220, 0.059); // #0f380f
const vec3 DMG_MID_D = vec3(0.188, 0.384, 0.188); // #306230
const vec3 DMG_MID_L = vec3(0.545, 0.675, 0.059); // #8bac0f
const vec3 DMG_LIGHT = vec3(0.608, 0.737, 0.059); // #9bbc0f

void main() {
  vec2 cell = vUv * uSourceSize;
  vec2 cellId = floor(cell);
  vec2 cellUv = fract(cell);
  vec2 sampleUv = (cellId + 0.5) / uSourceSize;
  vec3 src = texture2D(uFrame, sampleUv).rgb;
  float luma = dot(src, vec3(0.2126, 0.7152, 0.0722));
  vec3 dmg;
  if (luma < 0.333) {
    dmg = mix(DMG_DARK, DMG_MID_D, luma / 0.333);
  } else if (luma < 0.666) {
    dmg = mix(DMG_MID_D, DMG_MID_L, (luma - 0.333) / 0.333);
  } else {
    dmg = mix(DMG_MID_L, DMG_LIGHT, (luma - 0.666) / 0.334);
  }
  vec2 d = abs(cellUv - 0.5) * 2.0;
  float edge = max(d.x, d.y);
  float cellMask = smoothstep(0.98, 0.82, edge);
  vec3 gap = dmg * 0.88;
  dmg = mix(gap, dmg, cellMask);
  dmg *= 0.94 + 0.06 * vUv.y;
  gl_FragColor = vec4(colorGrade(dmg), 1.0);
}`;

// ─── Bloom-only shader ──────────────────────────────────────────────────
// The glow half of the CRT shader extracted on its own.
const FRAG_BLOOM = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

void main() {
  vec2 ps = 1.0 / uSourceSize;
  vec2 cell = vUv * uSourceSize;
  vec2 sampleUv = (floor(cell) + 0.5) / uSourceSize;
  vec3 color = texture2D(uFrame, sampleUv).rgb;
  vec3 halo = texture2D(uFrame, sampleUv + vec2( ps.x, 0.0)).rgb
            + texture2D(uFrame, sampleUv + vec2(-ps.x, 0.0)).rgb
            + texture2D(uFrame, sampleUv + vec2(0.0,  ps.y)).rgb
            + texture2D(uFrame, sampleUv + vec2(0.0, -ps.y)).rgb;
  color = mix(color, color + halo * 0.25, 0.35);
  gl_FragColor = vec4(colorGrade(color), 1.0);
}`;

// ─── Scanlines-only shader ──────────────────────────────────────────────
// Horizontal dimming at one cycle per source row, without CRT's
// curvature / aperture mask / bloom / vignette.
const FRAG_SCAN = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

void main() {
  vec2 cell = vUv * uSourceSize;
  vec2 sampleUv = (floor(cell) + 0.5) / uSourceSize;
  vec3 color = texture2D(uFrame, sampleUv).rgb;
  float scan = 0.5 + 0.5 * cos(vUv.y * uSourceSize.y * 6.2831853);
  color *= 0.72 + 0.28 * scan;
  gl_FragColor = vec4(colorGrade(color), 1.0);
}`;

// ─── MMPX (Style-Preserving Pixel-Art Magnification) ────────────────────
// Single-pass GLSL port of Morgan McGuire & Mara Gagiu's MMPX 2× scaler.
// Each input pixel E expands into 4 sub-pixels (J=NW, K=NE, L=SW, M=SE)
// via a sequence of pattern-match rules over a 5×5 + far-tap neighbourhood:
//
//   1. 1:1 slope rules — handle 45° edges between two regions.
//   2. Intersection rules — handle T-junctions and crossings.
//   3. 2:1 slope rules — handle steeper diagonals.
//
// Rules execute sequentially with overwrite semantics (later rules can
// modify earlier outputs). At canvas resolution > 2× source the shader
// snaps each output pixel to its containing MMPX sub-pixel — sharp
// 2× MMPX result with nearest-neighbour amplification to canvas size.
//
// Equality uses a half-byte epsilon so NEAREST-sampled byte textures
// compare reliably under mediump float.
//
// Upstream license, retained verbatim as required:
/*
   Copyright 2020 Morgan McGuire & Mara Gagiu.
   Available under the MIT license.
   https://casual-effects.com/research/McGuire2021PixelArt/
*/
const FRAG_MMPX = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

vec3 fetchAt(vec2 cellId, vec2 off) {
  vec2 ps = 1.0 / uSourceSize;
  return texture2D(uFrame, (cellId + off + 0.5) * ps).rgb;
}
bool eq(vec3 a, vec3 b) {
  return all(lessThan(abs(a - b), vec3(1.0/512.0)));
}
bool ne(vec3 a, vec3 b) { return !eq(a, b); }
float lumaOf(vec3 c) { return c.r + c.g + c.b; }

bool all_eq2(vec3 B, vec3 A0, vec3 A1) { return eq(B,A0) && eq(B,A1); }
bool all_eq3(vec3 B, vec3 A0, vec3 A1, vec3 A2) { return eq(B,A0) && eq(B,A1) && eq(B,A2); }
bool all_eq4(vec3 B, vec3 A0, vec3 A1, vec3 A2, vec3 A3) { return eq(B,A0) && eq(B,A1) && eq(B,A2) && eq(B,A3); }
bool any_eq3(vec3 B, vec3 A0, vec3 A1, vec3 A2) { return eq(B,A0) || eq(B,A1) || eq(B,A2); }
bool none_eq2(vec3 B, vec3 A0, vec3 A1) { return ne(B,A0) && ne(B,A1); }
bool none_eq4(vec3 B, vec3 A0, vec3 A1, vec3 A2, vec3 A3) { return ne(B,A0) && ne(B,A1) && ne(B,A2) && ne(B,A3); }

void main() {
  vec2 srcSpace = vUv * uSourceSize;
  vec2 cellId = floor(srcSpace);
  vec2 sub = srcSpace - cellId;

  vec3 A = fetchAt(cellId, vec2(-1.0, -1.0));
  vec3 B = fetchAt(cellId, vec2( 0.0, -1.0));
  vec3 C = fetchAt(cellId, vec2( 1.0, -1.0));
  vec3 D = fetchAt(cellId, vec2(-1.0,  0.0));
  vec3 E = fetchAt(cellId, vec2( 0.0,  0.0));
  vec3 F = fetchAt(cellId, vec2( 1.0,  0.0));
  vec3 G = fetchAt(cellId, vec2(-1.0,  1.0));
  vec3 H = fetchAt(cellId, vec2( 0.0,  1.0));
  vec3 I = fetchAt(cellId, vec2( 1.0,  1.0));
  vec3 Q = fetchAt(cellId, vec2(-2.0,  0.0));
  vec3 R = fetchAt(cellId, vec2( 2.0,  0.0));
  vec3 J = E, K = E, L = E, M = E;

  if (ne(A,E) || ne(B,E) || ne(C,E) || ne(D,E) || ne(F,E) || ne(G,E) || ne(H,E) || ne(I,E)) {
    vec3 P = fetchAt(cellId, vec2(0.0, -2.0));
    vec3 S = fetchAt(cellId, vec2(0.0,  2.0));
    float Bl = lumaOf(B), Dl = lumaOf(D), El = lumaOf(E), Fl = lumaOf(F), Hl = lumaOf(H);

    if (eq(D,B) && ne(D,H) && ne(D,F) && (El >= Dl || eq(E,A)) && any_eq3(E,A,C,G) && (El < Dl || ne(A,D) || ne(E,P) || ne(E,Q))) J = D;
    if (eq(B,F) && ne(B,D) && ne(B,H) && (El >= Bl || eq(E,C)) && any_eq3(E,A,C,I) && (El < Bl || ne(C,B) || ne(E,P) || ne(E,R))) K = B;
    if (eq(H,D) && ne(H,F) && ne(H,B) && (El >= Hl || eq(E,G)) && any_eq3(E,A,G,I) && (El < Hl || ne(G,H) || ne(E,S) || ne(E,Q))) L = H;
    if (eq(F,H) && ne(F,B) && ne(F,D) && (El >= Fl || eq(E,I)) && any_eq3(E,C,G,I) && (El < Fl || ne(I,H) || ne(E,R) || ne(E,S))) M = F;

    if (ne(E,F) && all_eq4(E,C,I,D,Q) && all_eq2(F,B,H) && ne(F, fetchAt(cellId, vec2( 3.0, 0.0)))) { K = F; M = F; }
    if (ne(E,D) && all_eq4(E,A,G,F,R) && all_eq2(D,B,H) && ne(D, fetchAt(cellId, vec2(-3.0, 0.0)))) { J = D; L = D; }
    if (ne(E,H) && all_eq4(E,G,I,B,P) && all_eq2(H,D,F) && ne(H, fetchAt(cellId, vec2(0.0,  3.0)))) { L = H; M = H; }
    if (ne(E,B) && all_eq4(E,A,C,H,S) && all_eq2(B,D,F) && ne(B, fetchAt(cellId, vec2(0.0, -3.0)))) { J = B; K = B; }
    if (Bl < El && all_eq4(E,G,H,I,S) && none_eq4(E,A,D,C,F)) { J = B; K = B; }
    if (Hl < El && all_eq4(E,A,B,C,P) && none_eq4(E,D,G,I,F)) { L = H; M = H; }
    if (Fl < El && all_eq4(E,A,D,G,Q) && none_eq4(E,B,C,I,H)) { K = F; M = F; }
    if (Dl < El && all_eq4(E,C,F,I,R) && none_eq4(E,B,A,G,H)) { J = D; L = D; }

    if (ne(H,B)) {
      if (ne(H,A) && ne(H,E) && ne(H,C)) {
        if (all_eq3(H,G,F,R) && none_eq2(H,D, fetchAt(cellId, vec2( 2.0, -1.0)))) L = M;
        if (all_eq3(H,I,D,Q) && none_eq2(H,F, fetchAt(cellId, vec2(-2.0, -1.0)))) M = L;
      }
      if (ne(B,I) && ne(B,G) && ne(B,E)) {
        if (all_eq3(B,A,F,R) && none_eq2(B,D, fetchAt(cellId, vec2( 2.0,  1.0)))) J = K;
        if (all_eq3(B,C,D,Q) && none_eq2(B,F, fetchAt(cellId, vec2(-2.0,  1.0)))) K = J;
      }
    }
    if (ne(F,D)) {
      if (ne(D,I) && ne(D,E) && ne(D,C)) {
        if (all_eq3(D,A,H,S) && none_eq2(D,B, fetchAt(cellId, vec2( 1.0,  2.0)))) J = L;
        if (all_eq3(D,G,B,P) && none_eq2(D,H, fetchAt(cellId, vec2( 1.0, -2.0)))) L = J;
      }
      if (ne(F,E) && ne(F,A) && ne(F,G)) {
        if (all_eq3(F,C,H,S) && none_eq2(F,B, fetchAt(cellId, vec2(-1.0,  2.0)))) K = M;
        if (all_eq3(F,I,B,P) && none_eq2(F,H, fetchAt(cellId, vec2(-1.0, -2.0)))) M = K;
      }
    }
  }

  vec3 outc;
  if (sub.x < 0.5) outc = sub.y < 0.5 ? J : L;
  else             outc = sub.y < 0.5 ? K : M;
  gl_FragColor = vec4(colorGrade(outc), 1.0);
}`;

// ─── Super-xBR (multi-pass) ─────────────────────────────────────────────
// Pass 1 reuses the xBR-lv2 kernel but renders into a 2× FBO. Pass 2 is
// this anti-ringing cleanup: samples the 3×3 neighbourhood of the 2×
// texture and clamps each output pixel to the local min/max, suppressing
// the halo / overshoot that weighted-blend upscalers sometimes produce
// around high-contrast edges.
const FRAG_SXBR_CLEANUP = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uSourceSize;

void main() {
  vec2 ps = 1.0 / uSourceSize;
  vec3 c = texture2D(uFrame, vUv).rgb;
  vec3 a = texture2D(uFrame, vUv + vec2(-ps.x, -ps.y)).rgb;
  vec3 b = texture2D(uFrame, vUv + vec2( 0.0,  -ps.y)).rgb;
  vec3 d = texture2D(uFrame, vUv + vec2( ps.x, -ps.y)).rgb;
  vec3 e = texture2D(uFrame, vUv + vec2(-ps.x,  0.0)).rgb;
  vec3 f = texture2D(uFrame, vUv + vec2( ps.x,  0.0)).rgb;
  vec3 g = texture2D(uFrame, vUv + vec2(-ps.x,  ps.y)).rgb;
  vec3 h = texture2D(uFrame, vUv + vec2( 0.0,   ps.y)).rgb;
  vec3 i = texture2D(uFrame, vUv + vec2( ps.x,  ps.y)).rgb;
  vec3 mn = min(min(min(a, b), min(d, e)), min(min(f, g), min(h, i)));
  vec3 mx = max(max(max(a, b), max(d, e)), max(max(f, g), max(h, i)));
  gl_FragColor = vec4(colorGrade(clamp(c, mn, mx)), 1.0);
}`;

export type ShaderName = "lcd" | "xbr" | "crt" | "dmg" | "bloom" | "scan" | "sxbr" | "mmpx";

/** Shader chain per mode. Single-string entries become a single-pass
 *  shader (renders straight to the canvas). Array entries define a
 *  multi-pass chain — each pass except the last renders into a 2×-native
 *  FBO; the last pass reads the FBO texture and renders to the canvas.
 *  The grading snippet is injected on the last pass only. */
export const FRAG_BY_NAME: Record<ShaderName, string | string[]> = {
  lcd: FRAG_LCD,
  xbr: FRAG_XBR,
  crt: FRAG_CRT,
  dmg: FRAG_DMG,
  bloom: FRAG_BLOOM,
  scan: FRAG_SCAN,
  sxbr: [FRAG_XBR, FRAG_SXBR_CLEANUP],
  mmpx: FRAG_MMPX
};

export interface ColorGrade {
  brightness: number;
  contrast: number;
  gamma: number;
  saturation: number;
  temperature: number;
}

export const DEFAULT_COLOR_GRADE: ColorGrade = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  saturation: 1,
  temperature: 0
};
