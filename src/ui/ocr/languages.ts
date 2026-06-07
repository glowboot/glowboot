/**
 * Destination languages for the translate overlay. Scoped to the set with
 * a ready offline Opus-MT model (see `MT_SUFFIXES` in `mt.ts` — keep the two
 * in sync), so every listed language works in *every* browser (offline)
 * and faster in Chrome/Edge (the built-in Translator API, which also
 * covers these). Languages only the Translator API supported are omitted
 * to avoid "works in one browser, not another" confusion.
 *
 * Single source of truth for the dropdown + the overlay header label.
 * Sorted by display name.
 */
export interface TranslateLanguage {
  code: string;
  name: string;
}

export const TRANSLATE_LANGUAGES: readonly TranslateLanguage[] = [
  { code: "ar", name: "Arabic" },
  { code: "zh", name: "Chinese" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
  { code: "sv", name: "Swedish" },
  { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" }
];

const SUPPORTED = new Set(TRANSLATE_LANGUAGES.map((l) => l.code));

/** Sentinel target meaning "don't translate — just read the recognised
 *  text aloud." Works in any browser (TTS, not the Translator API). */
export const READ_ORIGINAL = "none";

/** Fallback target when the browser's language(s) don't map to a supported
 *  non-English destination (e.g. an English-locale browser). We don't guess
 *  a foreign language — an English-locale user is likely reading the
 *  (English) game fine — so we default to read-aloud, and the user picks a
 *  translation target in Settings if they want one. */
const FALLBACK_TARGET = READ_ORIGINAL;

/** Map a BCP-47 browser tag to one of our supported codes, or null.
 *  Handles the cases where the browser code differs from Chrome's:
 *  Chinese script variants, Hebrew's modern `he` vs Chrome's `iw`, and
 *  Norwegian Bokmål/Nynorsk → `no`. */
function normalize(tag: string): string | null {
  const t = tag.toLowerCase();
  const primary = t.split("-")[0]!;
  if (primary === "zh") return /hant|tw|hk|mo/.test(t) ? "zh-Hant" : "zh";
  if (primary === "he") return "iw";
  if (primary === "nb" || primary === "nn") return "no";
  return primary;
}

/** Best default destination from the browser's preferred languages.
 *  Picks the first preferred language that maps to a supported, non-
 *  English target; falls back to {@link FALLBACK_TARGET} otherwise. */
export function defaultTranslateTarget(): string {
  const tags =
    typeof navigator === "undefined"
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : [];
  for (const tag of tags) {
    const code = normalize(tag);
    if (code && code !== "en" && SUPPORTED.has(code)) return code;
  }
  return FALLBACK_TARGET;
}

/** Display name for a code, falling back to the upper-cased code. */
export function languageName(code: string): string {
  return TRANSLATE_LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();
}
