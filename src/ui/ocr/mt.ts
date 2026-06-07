/**
 * Offline machine translation via transformers.js + per-language Opus-MT
 * models — the cross-browser half of translation (the Chromium Translator
 * API only exists in Chrome/Edge).
 *
 * Each supported language is a small (~100 MB) Opus-MT model in its own
 * repo (see `mtModelId`), downloaded on first use for that language and
 * cached by transformers.js.
 * Small per-language models (vs one ~600 MB universal model) are the key:
 * they fit the browser Cache API (so they persist instead of re-
 * downloading every session) and their inference is light enough not to
 * stall the emulator. Coverage is limited to the languages with a ready
 * ONNX export — others fall back to the Translator API / read-aloud.
 *
 * transformers.js (and the onnxruntime-web it bundles) loads from a
 * version-pinned jsdelivr CDN at runtime via a `/* @vite-ignore *​/`
 * dynamic import, so none of it touches our bundle. Inference runs on WASM.
 */

import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";

const TJS_VERSION = "4.2.0";
const TJS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/transformers.min.js`;

/** Repo-id prefix for the per-language Opus-MT models — one repo per
 *  language, `<prefix><suffix>` (e.g. `glowboot/translator-en-de`). One
 *  repo per model is what transformers.js actually supports: a single repo
 *  with per-language git branches does NOT work, because the library
 *  fetches `config.json` from `main` during model-type/dtype resolution
 *  regardless of the `revision` option. Defaults to our mirror; set
 *  VITE_MT_MODEL_PREFIX to "Xenova/opus-mt-en-" to use the public upstream. */
const MT_MODEL_PREFIX =
  ((import.meta.env.VITE_MT_MODEL_PREFIX as string | undefined) ?? "").trim() || "glowboot/translator-en-";

/** Target code → opus-mt model suffix. Only languages with a ready ONNX
 *  export (no self-conversion). Mostly identity; ja uses "jap". Opus-MT is
 *  direct en→X — no language token, unlike the multilingual models. */
const MT_SUFFIXES: Record<string, string> = {
  ar: "ar",
  zh: "zh",
  cs: "cs",
  da: "da",
  nl: "nl",
  fi: "fi",
  fr: "fr",
  de: "de",
  hi: "hi",
  hu: "hu",
  id: "id",
  it: "it",
  ja: "jap",
  ro: "ro",
  ru: "ru",
  es: "es",
  sv: "sv",
  uk: "uk",
  vi: "vi"
};

/** Resolve a target code to its transformers.js model id (one repo each). */
function mtModelId(code: string): string {
  return `${MT_MODEL_PREFIX}${MT_SUFFIXES[code]!}`;
}

/** Approx per-language download size — surfaced in the UI. */
export const MT_MODEL_SIZE_MB = 100;

type TranslatePipeline = (text: string) => Promise<{ translation_text: string }[]>;

/** Per-file download / load progress from transformers.js. */
export interface MtProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

/** True when the runtime can run (any browser with WASM). */
export function isMtSupported(): boolean {
  return typeof WebAssembly === "object" && typeof fetch === "function";
}

/** Whether an offline Opus-MT model exists for this target language. */
export function isMtLanguageSupported(code: string): boolean {
  return code in MT_SUFFIXES;
}

// Which languages the user has explicitly downloaded for offline use.
// Per-language (download is explicit, in Settings) rather than a single
// global toggle — the user picks exactly which models to fetch.
function downloadedSet(): string[] {
  try {
    const arr = JSON.parse(lsGet(KEYS.MT_DOWNLOADED) ?? "[]") as unknown;
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}
export function isMtDownloaded(code: string): boolean {
  return code in MT_SUFFIXES && downloadedSet().includes(code);
}
/** Fired (on `window`) when a language's model finishes downloading, so the
 *  Settings availability indicator refreshes even when the download was
 *  triggered elsewhere (e.g. the translate overlay's inline button). */
export const MT_DOWNLOADED_EVENT = "gb-mt-downloaded";

function markMtDownloaded(code: string): void {
  const set = downloadedSet();
  if (set.includes(code)) return;
  lsSet(KEYS.MT_DOWNLOADED, JSON.stringify([...set, code]));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MT_DOWNLOADED_EVENT, { detail: code }));
  }
}
/** Forget all downloaded-language flags (the cached models themselves stay
 *  in the browser cache — re-marking is instant). Used by section reset. */
export function clearMtDownloaded(): void {
  lsSet(KEYS.MT_DOWNLOADED, "[]");
}

type TjsModule = {
  pipeline: (task: string, model: string, opts?: unknown) => Promise<TranslatePipeline>;
  env?: { allowLocalModels?: boolean };
};
let tjsPromise: Promise<TjsModule> | null = null;
function loadTjs(): Promise<TjsModule> {
  if (!tjsPromise) {
    // @vite-ignore — runtime CDN import; keep transformers.js + its
    // bundled onnxruntime-web out of our bundle.
    tjsPromise = import(/* @vite-ignore */ TJS_CDN).then((tjs: TjsModule) => {
      if (tjs.env) tjs.env.allowLocalModels = false;
      return tjs;
    });
    tjsPromise.catch(() => {
      tjsPromise = null;
    });
  }
  return tjsPromise;
}

const pipelines = new Map<string, Promise<TranslatePipeline>>();

/** Load (downloading on first use) the Opus-MT pipeline for `code`.
 *  ~100 MB the first time, cached afterwards. `onProgress` drives the UI. */
export function prepareMt(code: string, onProgress?: (p: MtProgress) => void): Promise<TranslatePipeline> {
  if (!isMtLanguageSupported(code)) return Promise.reject(new Error(`No offline model for "${code}"`));
  const model = mtModelId(code);
  let p = pipelines.get(code);
  if (!p) {
    p = (async () => {
      const tjs = await loadTjs();
      const pipe = await tjs.pipeline("translation", model, {
        dtype: "q8",
        device: "wasm",
        // onnxruntime-web's MatMulNBits fusion can fail on these q8 exports
        // ("Missing required scale"); "basic" skips it and still builds.
        session_options: { graphOptimizationLevel: "basic" },
        progress_callback: onProgress
      });
      markMtDownloaded(code); // model is now fetched + cached
      return pipe;
    })();
    p.catch(() => pipelines.delete(code));
    pipelines.set(code, p);
  }
  return p;
}

const SENTENCE = /[^.!?]+[.!?]*/g;

/** Split into sentences — Opus-MT truncates multi-sentence input, so each
 *  sentence is translated separately and rejoined. */
export function splitSentences(text: string): string[] {
  return (
    text
      .match(SENTENCE)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [text]
  );
}

/** Translate English `text` to `code` (a supported language) with the
 *  offline Opus-MT model. Downloads the model on first use (`onProgress`),
 *  then runs per-sentence. */
export async function mtTranslate(text: string, code: string, onProgress?: (p: MtProgress) => void): Promise<string> {
  const translate = await prepareMt(code, onProgress);
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    const result = await translate(sentence);
    out.push(result[0]?.translation_text ?? "");
  }
  return out.join(" ").trim();
}
