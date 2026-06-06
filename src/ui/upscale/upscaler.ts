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

// ── Pure pixel <-> tensor conversion (unit-tested; no ORT/DOM) ──────────────

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
 *  dimensions (e.g. 240×160 GBA, 160×144 GB). Returns the 4× RGBA buffer.
 *  Throws on load/inference failure — callers show a toast. */
export async function upscaleFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Promise<UpscaleResult> {
  const ort = await loadOrt();
  try {
    return await runSession(ort, rgba, width, height);
  } catch (err) {
    // WebGPU *run* failure (e.g. the buffer-reuse shape mismatch this EP
    // hits on the dynamic-shape conv graph). The model runs fine on CPU,
    // so rebuild the session WASM-only and retry once before giving up.
    if (!forceWasm) {
      console.warn("[Upscale] inference failed on GPU; rebuilding on WASM and retrying:", err);
      forceWasm = true;
      sessionPromise = null;
      return await runSession(ort, rgba, width, height);
    }
    throw err;
  }
}
