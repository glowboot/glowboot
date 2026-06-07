/**
 * Text-to-speech narration for the translate overlay — the "speak the
 * result aloud" half of an AI-Service-style read/translate/narrate flow.
 *
 * Uses the browser's built-in Web Speech API (`speechSynthesis`): no
 * model, no download, no network, no key — and supported in every modern
 * browser (Chrome, Edge, Firefox, Safari), unlike the on-device Translator
 * API. The utterance `lang` is set so the platform picks a matching voice
 * (the translated text is spoken in the target language; the recognised
 * English is spoken as en).
 */

export function isNarrationSupported(): boolean {
  return (
    typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/** Make text speakable: collapse line breaks/whitespace and drop anything
 *  that isn't a letter (any script), digit, space, or sentence
 *  punctuation. OCR output carries stray symbols and hard line wraps that
 *  make TTS stumble (the recognised English especially); the translated
 *  text is already clean, so this is harmless there. Unicode-aware so it
 *  keeps accented letters (ä, é, …). */
export function cleanForSpeech(text: string): string {
  return (
    text
      .replace(/[^\p{L}\p{N} .,!?;:'"()…-]/gu, " ")
      // Lower-case ALL-CAPS words: many TTS engines spell those out
      // letter-by-letter ("P-O-K-E-M-O-N"). Game text (and OCR) is often
      // all-caps; translated text isn't, so this only affects the English
      // fallback path. Leaves mixed-case and single letters alone.
      .replace(/\b\p{Lu}{2,}\b/gu, (w) => w.toLowerCase())
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** macOS ships ~30 "novelty" voices (Zarvox, Trinoids, Whisper, Pipe
 *  Organ, Bad News, Bells, Cellos, …) that sound robotic/spooky. If the
 *  user has set one as their default voice, speaking with just a `lang`
 *  picks it — so we explicitly avoid these and choose a normal voice. */
const NOVELTY_VOICE =
  /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Princess|Ralph|Bruce|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Flo|Eddy)\b/i;

// Voices load asynchronously — `getVoices()` is often empty until the
// `voiceschanged` event fires. Warm the list at module load and keep it
// fresh so `pickVoice` has data the first time the user narrates (without
// it, the first call falls back to the system default = a novelty voice
// if the user set one).
if (isNarrationSupported()) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => window.speechSynthesis.getVoices());
}

/** Pick a sensible, non-novelty voice for `lang` rather than trusting the
 *  system default (which may be a joke voice). Returns null if voices
 *  aren't loaded yet or none match — caller then falls back to `lang`. */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const base = lang.split("-")[0]!.toLowerCase();
  const matches = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(base));
  if (matches.length === 0) return null;
  const normal = matches.filter((v) => !NOVELTY_VOICE.test(v.name));
  const pool = normal.length > 0 ? normal : matches;
  return pool.find((v) => v.localService) ?? pool[0]!;
}

/** Whether the OS has any voice for `lang`. TTS coverage is OS-dependent
 *  and doesn't span every language we translate to — used to hide the
 *  Speak button when speaking would fall through to a wrong-language
 *  voice. (If voices haven't loaded yet, returns true optimistically —
 *  narrate() defers until they load.) */
export function hasVoiceFor(lang: string): boolean {
  if (!isNarrationSupported()) return false;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return true;
  const base = lang.split("-")[0]!.toLowerCase();
  return voices.some((v) => v.lang.toLowerCase().startsWith(base));
}

/** Speak `text` in `lang` (BCP-47). Cancels any in-progress narration
 *  first so a fresh trigger doesn't queue behind the previous one. If the
 *  voice list isn't loaded yet, waits for it once so we never fall through
 *  to the (possibly novelty) system-default voice. */
export function narrate(text: string, lang: string): void {
  const clean = cleanForSpeech(text);
  if (!isNarrationSupported() || !clean) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const speak = (): void => {
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = lang;
    const voice = pickVoice(lang);
    if (voice) utterance.voice = voice;
    synth.speak(utterance);
  };
  if (synth.getVoices().length > 0) speak();
  else synth.addEventListener("voiceschanged", speak, { once: true });
}

/** Stop any in-progress narration (overlay close / re-trigger). */
export function stopNarration(): void {
  if (isNarrationSupported()) window.speechSynthesis.cancel();
}
