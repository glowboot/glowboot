/**
 * On-screen text recognition for the translate-overlay feature, backed by
 * PaddleOCR (PP-OCRv5) via the `ppu-paddle-ocr` library.
 *
 * PaddleOCR is a two-stage pipeline — a detection model finds text regions
 * anywhere on the frame, then a recognition model reads each one. That
 * replaces all the hand-rolled box-finding / cropping / upscaling / page-
 * segmentation tuning the old Tesseract path needed: we just hand it the
 * native framebuffer and reorder the detected words into reading order.
 *
 * The library (and the onnxruntime-web it rides on) loads entirely from a
 * version-pinned jsdelivr CDN at runtime via a `/* @vite-ignore *​/`
 * dynamic import, so none of it touches our bundle. The PP-OCRv5 model
 * files are fetched from our own HF mirror (so the feature doesn't depend
 * on a third-party host staying up) and cached on first use. Inference
 * uses WebGPU when available, WASM otherwise.
 */

const PADDLE_VERSION = "5.8.3";
const PADDLE_CDN = `https://cdn.jsdelivr.net/npm/ppu-paddle-ocr@${PADDLE_VERSION}/web/+esm`;

/** Base URL for the PP-OCRv5 model files. Unset → our HF mirror; set to a
 *  URL → that host; set to an EMPTY string → fall back to the library's own
 *  bundled defaults (handy before our mirror is populated). */
const OCR_MODEL_BASE_RAW = import.meta.env.VITE_OCR_MODEL_BASE as string | undefined;
const OCR_MODEL_BASE =
  OCR_MODEL_BASE_RAW === undefined
    ? "https://huggingface.co/glowboot/recognizers/resolve/main"
    : OCR_MODEL_BASE_RAW.trim();
const MODEL_FILES = OCR_MODEL_BASE
  ? {
      detection: `${OCR_MODEL_BASE}/PP-OCRv5_mobile_det_infer.ort`,
      recognition: `${OCR_MODEL_BASE}/en_PP-OCRv5_mobile_rec_infer.ort`,
      charactersDictionary: `${OCR_MODEL_BASE}/ppocrv5_en_dict.txt`
    }
  : null;

interface PaddleWord {
  text: string;
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
}
interface PaddleResult {
  text: string;
  lines: PaddleWord[][];
  confidence: number;
}
interface PaddleService {
  initialize(): Promise<void>;
  recognize(image: HTMLCanvasElement, options?: { noCache?: boolean }): Promise<PaddleResult>;
}
type PaddleCtor = new (options?: unknown) => PaddleService;

/** Detection tuning for low-res game frames (vs the library defaults aimed
 *  at photos/receipts). A higher maxSideLength lets detection see the tiny
 *  text at more resolution, and extra box padding gives the recogniser more
 *  glyph context — measured to lift both clean fonts and stylised ones. */
const DETECTION_OPTIONS = {
  detection: { maxSideLength: 1280, paddingHorizontal: 1.0, paddingVertical: 0.6 }
};

export interface OcrResult {
  text: string;
  confidence: number;
}

/** True when OCR can run (browser with WASM + canvas). */
export function isOcrSupported(): boolean {
  return typeof WebAssembly === "object" && typeof document !== "undefined";
}

let servicePromise: Promise<PaddleService> | null = null;

async function getService(): Promise<PaddleService> {
  if (!servicePromise) {
    servicePromise = (async () => {
      // @vite-ignore — runtime CDN import; keep ppu-paddle-ocr + its
      // bundled onnxruntime-web out of our bundle.
      const mod = (await import(/* @vite-ignore */ PADDLE_CDN)) as {
        PaddleOcrService?: PaddleCtor;
        default?: { PaddleOcrService?: PaddleCtor };
      };
      const Ctor = mod.PaddleOcrService ?? mod.default?.PaddleOcrService;
      if (typeof Ctor !== "function") {
        throw new Error("ppu-paddle-ocr: PaddleOcrService export not found");
      }
      const service = new Ctor(MODEL_FILES ? { ...DETECTION_OPTIONS, model: MODEL_FILES } : DETECTION_OPTIONS);
      await service.initialize();
      return service;
    })();
    servicePromise.catch(() => {
      servicePromise = null;
    });
  }
  return servicePromise;
}

/** Reorder PaddleOCR's per-word detections into reading order: group into
 *  lines by vertical position, then left-to-right within each line. The
 *  raw `lines` grouping isn't reliably ordered, so we rebuild it from the
 *  word boxes. */
export function readingOrder(lines: PaddleWord[][]): string {
  const words = lines.flat().filter((w) => w && w.box);
  if (words.length === 0) return "";
  const heights = words.map((w) => w.box.height).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;
  const sorted = [...words].sort((a, b) => a.box.y - b.box.y);
  const rows: PaddleWord[][] = [];
  let row: PaddleWord[] = [];
  for (const w of sorted) {
    if (row.length > 0 && w.box.y - row[0]!.box.y > medianH * 0.6) {
      rows.push(row);
      row = [];
    }
    row.push(w);
  }
  if (row.length > 0) rows.push(row);
  return rows
    .map((r) =>
      r
        .sort((a, b) => a.box.x - b.box.x)
        .map((w) => w.text)
        .join(" ")
    )
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Recognise text in a native RGBA frame. Returns the text in reading
 *  order + the engine's confidence (0–1). Throws on load/recognise
 *  failure. */
export async function recognize(rgba: Uint8ClampedArray, width: number, height: number): Promise<OcrResult> {
  const service = await getService();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext("2d")!
    .putImageData(new ImageData(new Uint8ClampedArray(rgba.subarray(0, width * height * 4)), width, height), 0, 0);
  // noCache: the library keys its result cache on a hash of only the first
  // 1024 bytes — game screens that share a top row (sky/HUD) collide and
  // would otherwise return a stale earlier frame's text.
  const result = await service.recognize(canvas, { noCache: true });
  return { text: readingOrder(result.lines) || result.text.trim(), confidence: result.confidence ?? 0 };
}

/** Warm the engine ahead of first use (library + models download). */
export async function prewarmOcr(): Promise<void> {
  try {
    await getService();
  } catch {
    /* surfaced on the real recognize call */
  }
}
