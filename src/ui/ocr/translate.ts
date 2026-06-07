/**
 * On-device translation via the browser Translator API (Chrome 138+).
 *
 * Runs entirely on-device — the recognised text never leaves the
 * machine — and needs no API key, matching Glowboot's no-server,
 * privacy-preserving stance. It's Chrome-only and still relatively new,
 * so everything is feature-detected: where the API is absent (Firefox,
 * Safari) the caller falls back to showing the recognised source text.
 *
 * The first use of a given language pair downloads a small on-device
 * model; `prepare()` lets the UI trigger + report that ahead of time.
 */

// Minimal shape of the Translator API we use (no ambient lib types yet).
interface TranslatorInstance {
  translate(input: string): Promise<string>;
}
interface TranslatorCtor {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<TranslatorInstance>;
}

function ctor(): TranslatorCtor | null {
  return (globalThis as unknown as { Translator?: TranslatorCtor }).Translator ?? null;
}

/** True when the browser exposes the on-device Translator API. */
export function isTranslateSupported(): boolean {
  return ctor() !== null;
}

const SOURCE = "en";
let cached: { target: string; instance: Promise<TranslatorInstance> } | null = null;

/** Capability of en→`target` in this browser:
 *   - "unsupported": no Translator API at all (non-Chromium, or disabled)
 *   - "unavailable": API present but this language pair isn't offered
 *   - "downloadable" / "downloading": usable, model not yet local
 *   - "available": ready to use immediately */
export type TranslateAvailability = "available" | "downloadable" | "downloading" | "unavailable" | "unsupported";

export async function translateAvailability(target: string): Promise<TranslateAvailability> {
  const T = ctor();
  if (!T) return "unsupported";
  try {
    const a = await T.availability({ sourceLanguage: SOURCE, targetLanguage: target });
    if (a === "available" || a === "downloadable" || a === "downloading") return a;
    return "unavailable";
  } catch {
    return "unsupported";
  }
}

/** Whether the en→`target` pair can run (model available or downloadable).
 *  Returns false when the API is missing or the pair is unsupported. */
export async function canTranslateTo(target: string): Promise<boolean> {
  const a = await translateAvailability(target);
  return a !== "unavailable" && a !== "unsupported";
}

/** Translate English `text` to `target` (BCP-47, e.g. "pt", "fr", "de").
 *  The translator instance is memoised per target — first use of a pair
 *  may block while its on-device model downloads. Throws when the API is
 *  unavailable; callers degrade to the source text. */
export async function translate(text: string, target: string): Promise<string> {
  const T = ctor();
  if (!T) throw new Error("Translator API unavailable");
  if (!cached || cached.target !== target) {
    cached = { target, instance: T.create({ sourceLanguage: SOURCE, targetLanguage: target }) };
    cached.instance.catch(() => {
      cached = null; // don't cache a failed create
    });
  }
  const translator = await cached.instance;
  return translator.translate(text);
}
