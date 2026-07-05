/**
 * AI sprite upscaler — 4× super-resolution of a native console frame via
 * the PixelPerfect ESRGAN sprite model running in ONNX Runtime Web.
 *
 * Used for the "Enhance with AI" screenshot action: a one-shot upscale of
 * the raw PPU framebuffer (NOT the shader-displayed canvas — feeding an
 * already-MMPX'd image would double-process it). The model is trained on
 * pixel art, so sprite linework stays crisp while aliasing is cleaned up.
 *
 * Cost is paid lazily and once:
 *   - The ENTIRE ORT module (JS glue + its multi-MB WASM runtime) loads
 *     from the version-pinned jsdelivr CDN at runtime, via a
 *     `/* @vite-ignore *​/` dynamic import. Nothing ORT-related ends up in
 *     our bundle — the npm `onnxruntime-web` dep is used for TYPES ONLY
 *     (`import type`, erased at build). This deliberately sidesteps Vite
 *     emitting ORT's 12–25 MB `.wasm` as a local asset (its internal
 *     `new URL('….wasm', import.meta.url)` would otherwise get bundled).
 *     The CDN module fetches its sibling `.wasm` from the CDN itself.
 *   - The model (~32 MB fp16) is fetched from the project's Hugging Face
 *     repo by default (off-repo — too big for the Pages 25 MiB file
 *     limit); `VITE_UPSCALE_MODEL_URL` overrides the source.
 *   - The session is built once and memoised.
 *
 * Execution provider: WebGPU when the browser exposes `navigator.gpu`,
 * otherwise the WASM (CPU) EP. WASM threads need cross-origin isolation,
 * which the deploy doesn't set — ORT degrades to single-thread on its own,
 * which still works, just slower.
 */

import type * as Ort from "onnxruntime-web";

const ORT_VERSION = "1.26.0";
/** Version-pinned ORT WebGPU ESM bundle on jsdelivr. Must match the
 *  `onnxruntime-web` dep version (kept for types) — bump both together.
 *  The module resolves its own sibling `.wasm` from the same CDN dir. */
const ORT_CDN_MODULE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.bundle.min.mjs`;
const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/** Where the upscaler model is fetched from. Defaults to the project's
 *  Hugging Face repo (the model is too large for the Cloudflare Pages
 *  25 MiB per-file limit, so it's hosted off-repo). `VITE_UPSCALE_MODEL_URL`
 *  overrides it — for swapping in a different model without a code change,
 *  or pointing at a local copy in dev. A fetch failure only disables
 *  Enhance; the rest of the app is unaffected. */
const MODEL_URL =
  ((import.meta.env.VITE_UPSCALE_MODEL_URL as string | undefined) ?? "").trim() ||
  "https://huggingface.co/glowboot/upscalers/resolve/main/pixelperfect-x4-fp16.onnx";

/** The model has a FIXED input shape (static dims fix ORT's WebGPU
 *  buffer planner — dynamic dims trip a "re-use buffer" error). Frames
 *  smaller than this (GB is 160×144) are edge-padded up to it, then the
 *  4× output is cropped back to the real size. GBA (240×160) fits exactly. */
const FIXED_W = 240;
const FIXED_H = 160;
const SCALE = 4;

export interface UpscaleResult {
  data: Uint8ClampedArray; // RGBA, width*height*4
  width: number; // 4× input
  height: number;
}

// ── Pure pixel <-> tensor conversion (no ORT/DOM) ──────────────

/** RGBA8888 → planar NCHW float32 RGB in [0,1]. Drops alpha (the console
 *  framebuffer is fully opaque). Layout: [R-plane, G-plane, B-plane]. */
export function rgbaToNchw(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[i * 4]! / 255;
    out[n + i] = rgba[i * 4 + 1]! / 255;
    out[2 * n + i] = rgba[i * 4 + 2]! / 255;
  }
  return out;
}

/** Planar NCHW float32 RGB in [0,1] → RGBA8888 with opaque alpha.
 *  Out-of-range values are clamped (the model can overshoot slightly). */
export function nchwToRgba(chw: Float32Array, width: number, height: number): Uint8ClampedArray {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = chw[i]! * 255;
    out[i * 4 + 1] = chw[n + i]! * 255;
    out[i * 4 + 2] = chw[2 * n + i]! * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Edge-pad an RGBA frame up to `dstW`×`dstH`, anchored top-left, by
 *  clamping out-of-range coordinates to the nearest source pixel.
 *  Replicate (not black) padding avoids a hard content/background edge
 *  the model would otherwise try to "enhance". No-op when sizes match. */
export function padToFixed(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  dstW: number,
  dstH: number
): Uint8ClampedArray {
  if (w === dstW && h === dstH) return new Uint8ClampedArray(rgba.subarray(0, w * h * 4));
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = y < h ? y : h - 1;
    for (let x = 0; x < dstW; x++) {
      const sx = x < w ? x : w - 1;
      const s = (sy * w + sx) * 4;
      const d = (y * dstW + x) * 4;
      out[d] = rgba[s]!;
      out[d + 1] = rgba[s + 1]!;
      out[d + 2] = rgba[s + 2]!;
      out[d + 3] = 255;
    }
  }
  return out;
}

/** Crop the top-left `cropW`×`cropH` region out of a `srcW`-wide RGBA
 *  buffer — undoes {@link padToFixed} on the upscaled output. */
export function cropTopLeft(rgba: Uint8ClampedArray, srcW: number, cropW: number, cropH: number): Uint8ClampedArray {
  if (cropW === srcW) return rgba.subarray(0, cropW * cropH * 4) as Uint8ClampedArray;
  const out = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    out.set(rgba.subarray(y * srcW * 4, (y * srcW + cropW) * 4), y * cropW * 4);
  }
  return out;
}

// ── Tiling (frames larger than the model's fixed input) ─────────────────────

/** Source-pixel overlap between adjacent tiles — gives the model context
 *  past each tile's core so its edge artifacts land in the feathered band
 *  that the stitch weights down. */
const TILE_OVERLAP = 16;
/** Output-pixel cross-fade width at internal tile seams. Kept below
 *  `TILE_OVERLAP * SCALE` so the ramp always fits inside the overlap. */
const TILE_FEATHER = 32;
/** Largest source frame the tiler accepts — guards against an absurd input
 *  spawning hundreds of passes. Covers every retro console (≤ 256×240). */
const MAX_UPSCALE_DIM = 512;

interface UpscaleTile {
  sx: number;
  sy: number;
  tw: number;
  th: number;
  featherLeft: boolean;
  featherRight: boolean;
  featherTop: boolean;
  featherBottom: boolean;
}

/** Full-size tile origins covering `[0, len)`; the last is flush to the far
 *  edge so every tile is exactly `tile` long where the frame allows. Returns
 *  `[0]` when the frame already fits one tile. */
function tileOrigins(len: number, tile: number, overlap: number): number[] {
  if (len <= tile) return [0];
  const step = tile - overlap;
  const origins: number[] = [];
  for (let o = 0; o + tile < len; o += step) origins.push(o);
  origins.push(len - tile);
  return origins;
}

/** Split a `width`×`height` frame into ≤ FIXED_W×FIXED_H tiles. An edge that
 *  borders another tile (not the frame edge) is flagged for feathering so
 *  the stitch cross-fades it instead of showing a seam. */
function planUpscaleTiles(width: number, height: number): UpscaleTile[] {
  const xs = tileOrigins(width, FIXED_W, TILE_OVERLAP);
  const ys = tileOrigins(height, FIXED_H, TILE_OVERLAP);
  const tiles: UpscaleTile[] = [];
  for (const sy of ys) {
    const th = Math.min(FIXED_H, height - sy);
    for (const sx of xs) {
      const tw = Math.min(FIXED_W, width - sx);
      tiles.push({
        sx,
        sy,
        tw,
        th,
        featherLeft: sx > 0,
        featherRight: sx + tw < width,
        featherTop: sy > 0,
        featherBottom: sy + th < height
      });
    }
  }
  return tiles;
}

/** Copy a `tw`×`th` region at (`sx`,`sy`) out of a `srcW`-wide RGBA buffer. */
function extractTile(
  rgba: Uint8ClampedArray | Uint8Array,
  srcW: number,
  sx: number,
  sy: number,
  tw: number,
  th: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const s = ((sy + y) * srcW + sx) * 4;
    out.set(rgba.subarray(s, s + tw * 4), y * tw * 4);
  }
  return out;
}

/** Linear feather weight along one axis: 1 in the interior, ramping to ~0
 *  over `TILE_FEATHER` output px at each edge flagged internal. A tiny floor
 *  keeps the weighted-sum divisor non-zero. */
function edgeWeight(pos: number, len: number, featherStart: boolean, featherEnd: boolean): number {
  let w = 1;
  if (featherStart) w = Math.min(w, (pos + 0.5) / TILE_FEATHER);
  if (featherEnd) w = Math.min(w, (len - pos - 0.5) / TILE_FEATHER);
  return w > 1e-3 ? w : 1e-3;
}

/** Accumulate one upscaled tile's RGB into the weighted-sum buffers at its
 *  output origin. Seams vanish because each tile's artifact-prone internal
 *  border is feathered toward its neighbour's artifact-free interior. */
function accumulateTile(
  acc: Float32Array,
  wsum: Float32Array,
  outW: number,
  tile: Uint8ClampedArray,
  dstX: number,
  dstY: number,
  tileW: number,
  tileH: number,
  feather: Pick<UpscaleTile, "featherLeft" | "featherRight" | "featherTop" | "featherBottom">
): void {
  for (let ly = 0; ly < tileH; ly++) {
    const wy = edgeWeight(ly, tileH, feather.featherTop, feather.featherBottom);
    for (let lx = 0; lx < tileW; lx++) {
      const w = wy * edgeWeight(lx, tileW, feather.featherLeft, feather.featherRight);
      const s = (ly * tileW + lx) * 4;
      const g = (dstY + ly) * outW + (dstX + lx);
      acc[g * 3] = acc[g * 3]! + tile[s]! * w;
      acc[g * 3 + 1] = acc[g * 3 + 1]! + tile[s + 1]! * w;
      acc[g * 3 + 2] = acc[g * 3 + 2]! + tile[s + 2]! * w;
      wsum[g] = wsum[g]! + w;
    }
  }
}

/** Resolve the weighted-sum buffers into a final opaque RGBA image. */
function resolveAccumulator(acc: Float32Array, wsum: Float32Array, outW: number, outH: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0; i < outW * outH; i++) {
    const w = wsum[i]!;
    out[i * 4] = acc[i * 3]! / w;
    out[i * 4 + 1] = acc[i * 3 + 1]! / w;
    out[i * 4 + 2] = acc[i * 3 + 2]! / w;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ── Session (lazy, memoised) ────────────────────────────────────────────────

type OrtModule = typeof Ort;
type Session = Ort.InferenceSession;

let ortPromise: Promise<OrtModule> | null = null;
let sessionPromise: Promise<Session> | null = null;
/** Sticks to the WASM EP after a WebGPU run fails. Belt-and-suspenders:
 *  the model now ships with a FIXED input shape (the dynamic-shape build
 *  tripped ORT's WebGPU buffer planner — "Shape mismatch attempting to
 *  re-use buffer"), which should let WebGPU run it. If a GPU run still
 *  fails for any reason, we drop to WASM (slower but reliable) rather
 *  than fail the feature. */
let forceWasm = false;

/** True when the runtime can plausibly run — i.e. we're in a browser.
 *  WebGPU is preferred but not required (WASM fallback). */
export function isUpscaleSupported(): boolean {
  return typeof fetch === "function" && typeof WebAssembly === "object";
}

/** Whether the GPU execution path is available (affects expected latency
 *  the UI can surface, not correctness). */
export function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/** Whether a frame fits the model's fixed input in a single pass. Smaller
 *  frames are edge-padded up (GB 160×144, GBA 240×160). Larger frames
 *  (NES 256×240, SNES 256×224) exceed it and go through the tiled path
 *  instead — see {@link planUpscaleTiles}. */
export function fitsUpscaleModel(width: number, height: number): boolean {
  return width <= FIXED_W && height <= FIXED_H;
}

/** Whether Enhance can run on a frame of this size at all: single-pass when
 *  it fits the model, tiled otherwise, up to a sane cap. Callers gate the
 *  Enhance action on this. */
export function canUpscale(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= MAX_UPSCALE_DIM && height <= MAX_UPSCALE_DIM;
}

async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    // @vite-ignore — keep this a runtime CDN import; do NOT let Vite
    // resolve/bundle it (that would pull ORT's wasm into our assets).
    ortPromise = import(/* @vite-ignore */ ORT_CDN_MODULE).then((ort: OrtModule) => {
      // Belt-and-suspenders: the CDN module already resolves its wasm
      // relative to itself, but pin the path explicitly too.
      ort.env.wasm.wasmPaths = ORT_CDN_BASE;
      return ort;
    });
  }
  return ortPromise;
}

async function getSession(): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt();
      const useGpu = !forceWasm && hasWebGpu();
      const executionProviders = useGpu ? (["webgpu", "wasm"] as const) : (["wasm"] as const);
      try {
        return await ort.InferenceSession.create(MODEL_URL, { executionProviders: [...executionProviders] });
      } catch (err) {
        // A WebGPU init failure (driver quirk, blocklist) shouldn't sink
        // the feature — retry once on the WASM EP alone.
        if (useGpu) {
          console.warn("[Upscale] WebGPU session failed; falling back to WASM:", err);
          forceWasm = true;
          return await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
        }
        throw err;
      }
    })();
    // Don't cache a rejected attempt — let the next call retry from scratch.
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

/** Run the model once on the current session. Pads the frame up to the
 *  model's fixed input, runs, then crops the 4× output back to the real
 *  size. Split out so `upscaleFrame` can retry on a rebuilt WASM session
 *  if a WebGPU *run* fails. */
async function runSession(ort: OrtModule, rgba: Uint8ClampedArray | Uint8Array, width: number, height: number) {
  const session = await getSession();
  const padded = padToFixed(rgba, width, height, FIXED_W, FIXED_H);
  const input = new ort.Tensor("float32", rgbaToNchw(padded, FIXED_W, FIXED_H), [1, 3, FIXED_H, FIXED_W]);
  try {
    const output = await session.run({ [session.inputNames[0]!]: input });
    const out = output[session.outputNames[0]!]!;
    const [, , outH, outW] = out.dims as readonly number[];
    const full = nchwToRgba(out.data as Float32Array, outW!, outH!);
    out.dispose();
    const data = cropTopLeft(full, outW!, width * SCALE, height * SCALE);
    return { data, width: width * SCALE, height: height * SCALE } satisfies UpscaleResult;
  } finally {
    input.dispose();
  }
}

/** Warm the model + runtime ahead of the first real upscale (e.g. on
 *  popover open) so the user doesn't eat the full cold-start latency at
 *  click time. Safe to call repeatedly; swallows errors. */
export async function prewarmUpscaler(): Promise<void> {
  try {
    await getSession();
  } catch {
    /* surfaced for real on the actual upscale call */
  }
}

/** Upscale a native RGBA frame 4×. `width`/`height` are the source
 *  dimensions (240×160 GBA, 160×144 GB, 256×240 NES, 256×224 SNES). Frames
 *  within the model's fixed input run in one pass; larger ones are tiled and
 *  feather-stitched. Throws on load/inference failure — callers show a toast. */
export async function upscaleFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Promise<UpscaleResult> {
  const ort = await loadOrt();
  if (fitsUpscaleModel(width, height)) return await runWithFallback(ort, rgba, width, height);
  return await runTiled(ort, rgba, width, height);
}

/** One model pass with the GPU→WASM fallback: a WebGPU *run* failure (e.g.
 *  the buffer-reuse shape mismatch that EP hits on the conv graph) rebuilds
 *  the session WASM-only and retries once — the model runs fine on CPU. */
async function runWithFallback(
  ort: OrtModule,
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Promise<UpscaleResult> {
  try {
    return await runSession(ort, rgba, width, height);
  } catch (err) {
    if (!forceWasm) {
      console.warn("[Upscale] inference failed on GPU; rebuilding on WASM and retrying:", err);
      forceWasm = true;
      sessionPromise = null;
      return await runSession(ort, rgba, width, height);
    }
    throw err;
  }
}

/** Upscale a frame larger than the model's fixed input by splitting it into
 *  overlapping tiles, upscaling each, and feather-blending the 4× outputs. */
async function runTiled(
  ort: OrtModule,
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Promise<UpscaleResult> {
  const outW = width * SCALE;
  const outH = height * SCALE;
  const acc = new Float32Array(outW * outH * 3);
  const wsum = new Float32Array(outW * outH);
  for (const t of planUpscaleTiles(width, height)) {
    const src = extractTile(rgba, width, t.sx, t.sy, t.tw, t.th);
    const up = await runWithFallback(ort, src, t.tw, t.th);
    accumulateTile(acc, wsum, outW, up.data, t.sx * SCALE, t.sy * SCALE, t.tw * SCALE, t.th * SCALE, t);
  }
  return { data: resolveAccumulator(acc, wsum, outW, outH), width: outW, height: outH };
}
