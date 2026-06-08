/**
 * Translate-overlay flow — Glowboot's zero-setup "AI Service": read the
 * on-screen text, translate it, and (optionally) speak it aloud, in a
 * non-blocking panel docked to the bottom. On-demand: each trigger
 * re-reads the current frame; the game keeps running so the player can
 * move and re-trigger. All on-device — no server, no API key.
 *
 * Pipeline: `ocr.ts` (recognise, PaddleOCR) + `translate.ts` (on-device
 * Translator API) + `narrate.ts` (Web Speech TTS). Degrades gracefully:
 * no text found → a note; no usable Translator API (non-Chromium, or
 * disabled) → shows the recognised English; narration falls back to
 * speaking that English when translation is unavailable.
 */

import { makeDraggablePanel } from "../draggable.js";
import { KEYS } from "../persistence/local-storage.js";
import { languageName, READ_ORIGINAL } from "./languages.js";
import {
  isMtDownloaded,
  isMtLanguageSupported,
  isMtSupported,
  MT_MODEL_SIZE_MB,
  type MtProgress,
  mtTranslate,
  prepareMt
} from "./mt.js";
import { hasVoiceFor, narrate, stopNarration } from "./narrate.js";
import { isOcrSupported, recognize } from "./ocr.js";
import { canTranslateTo, isTranslateSupported, translate } from "./translate.js";

let activeOverlay: HTMLElement | null = null;
let lastFocus: HTMLElement | null = null;

export function isTranslateOverlayOpen(): boolean {
  return activeOverlay !== null;
}

function close(): void {
  if (!activeOverlay) return;
  stopNarration();
  activeOverlay.remove();
  activeOverlay = null;
  document.removeEventListener("keydown", onKeydown, true);
  // Event name shared with popovers/index.ts (fired when any popover opens).
  window.removeEventListener("gb-popover-open", close);
  lastFocus?.focus?.();
  lastFocus = null;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    close();
  }
}

/**
 * Open the translate overlay for a captured native frame. Replaces any
 * overlay already open (each trigger re-captures the current screen).
 * @param rgba    native RGBA framebuffer
 * @param width   native width (160 GB / 240 GBA)
 * @param height  native height (144 GB / 160 GBA)
 * @param target  BCP-47 target language (e.g. "pt")
 * @param onBusy  called with `true` while OCR/translation is computing and
 *                `false` when done — the caller pauses the emulator during
 *                the compute so the on-main-thread WASM inference doesn't
 *                stutter the render loop. Result reading happens unpaused.
 */
export function openTranslateOverlay(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  target: string,
  onBusy?: (busy: boolean) => void
): void {
  close();
  lastFocus = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay tr-overlay";
  // Non-modal info panel (the overlay is pointer-events:none so the game
  // stays playable underneath); dismiss via ✕ or Escape.
  overlay.setAttribute("role", "region");
  overlay.setAttribute("aria-label", "Translation");

  const panel = document.createElement("div");
  panel.className = "modal-panel tr-panel";
  panel.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "tr-head";
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = target === READ_ORIGINAL ? "On-screen text" : `Translation — ${languageName(target)}`;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ss-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", close);
  head.append(title, closeBtn);

  const status = document.createElement("div");
  status.className = "tr-status";
  status.textContent = "Reading screen…";

  const body = document.createElement("div");
  body.className = "tr-body";
  body.hidden = true;

  panel.append(head, status, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  // Draggable by the header; position remembered (default = bottom-right).
  makeDraggablePanel(panel, head, KEYS.TRANSLATE_PANEL_POS, closeBtn);
  document.addEventListener("keydown", onKeydown, true);
  // Dismiss when a popover opens — a docked overlay floating above the
  // Settings/other popovers reads as broken (fired by popovers/index.ts).
  window.addEventListener("gb-popover-open", close);
  // Deliberately do NOT move focus into the panel: keeping focus on the
  // game canvas means game input + the Translate hotkey keep working, so
  // the player can move to another screen and re-trigger the translation.

  async function run(): Promise<void> {
    // Reset the title each run so a re-run (e.g. after an inline download)
    // restores the translation header rather than a stale "On-screen text".
    title.textContent = target === READ_ORIGINAL ? "On-screen text" : `Translation — ${languageName(target)}`;
    body.hidden = true;
    status.hidden = false;
    status.textContent = "Reading screen…";
    // Pause the emulator while the OCR/translation runs — the inference is
    // on the main thread, so leaving the game running just stutters it.
    onBusy?.(true);
    try {
      if (!isOcrSupported()) throw new Error("OCR unsupported in this browser");
      const { text } = await recognize(rgba, width, height);
      if (!text) {
        status.textContent = "No readable text found on screen.";
        return;
      }

      let translated: string | null = null;
      let note = "";
      let offerDownload = false;
      if (target !== READ_ORIGINAL) {
        if (isTranslateSupported() && (await canTranslateTo(target))) {
          // Tier 1: Chromium Translator API (fast, tiny).
          status.textContent = "Translating…";
          try {
            translated = await translate(text, target);
          } catch {
            note = "Translation failed — reading the on-screen text aloud instead.";
          }
        } else if (isMtDownloaded(target)) {
          // Tier 2: offline Opus-MT (downloaded for this language in Settings).
          status.textContent = "Translating offline…";
          try {
            translated = await mtTranslate(text, target);
          } catch (err) {
            console.warn("[Translate] offline translation failed:", err);
            note = "Offline translation failed — reading the on-screen text aloud instead.";
          }
        } else if (isMtLanguageSupported(target) && isMtSupported()) {
          // Offline-capable but not downloaded yet — offer to fetch it right
          // here (read aloud meanwhile); the button re-runs once it's ready.
          offerDownload = true;
          note = `${languageName(target)} translates offline after a one-time ~${MT_MODEL_SIZE_MB} MB download — reading aloud for now.`;
        } else {
          // No offline model for this language and no built-in translator.
          note = isTranslateSupported()
            ? `${languageName(target)} isn't available in this browser — reading the on-screen text aloud instead.`
            : `Translation needs Chrome/Edge — reading the on-screen text aloud instead.`;
        }
      }

      // When a translation was wanted but we fell back, the panel is now a
      // read-aloud of the on-screen text — retitle it so it doesn't claim
      // to be a translation.
      if (!translated && target !== READ_ORIGINAL) title.textContent = "On-screen text";

      status.hidden = true;
      body.hidden = false;
      body.innerHTML = "";
      if (translated) {
        const t = document.createElement("p");
        t.className = "tr-translated";
        t.textContent = translated;
        body.appendChild(t);
      }
      const orig = document.createElement("p");
      orig.className = "tr-original";
      orig.textContent = text;
      body.appendChild(orig);
      if (note) {
        const n = document.createElement("p");
        n.className = "tr-note";
        n.textContent = note;
        body.appendChild(n);
      }

      // Action buttons share one row — Speak first, then Download.
      const actions = document.createElement("div");
      actions.className = "tr-actions";

      // Narration: speak the translation in the target language, or the
      // recognised English when no translation is available. Only offer Speak
      // when the OS actually has a voice for that language.
      const spokenText = translated ?? text;
      const spokenLang = translated ? target : "en";
      if (hasVoiceFor(spokenLang)) {
        const speakBtn = document.createElement("button");
        speakBtn.type = "button";
        speakBtn.className = "tr-speak";
        speakBtn.textContent = "🔊 Speak";
        speakBtn.title = "Read this aloud";
        speakBtn.addEventListener("click", () => narrate(spokenText, spokenLang));
        actions.appendChild(speakBtn);
      }

      // Inline offline-model download for a downloadable language — fetch
      // (game keeps running; it's a network download) then re-run, which now
      // routes through Tier 2 and translates.
      if (offerDownload) {
        const dlBtn = document.createElement("button");
        dlBtn.type = "button";
        dlBtn.className = "tr-speak";
        dlBtn.textContent = `⤓ Download ${languageName(target)} (~${MT_MODEL_SIZE_MB} MB)`;
        dlBtn.title = "Download this language for offline translation";
        dlBtn.addEventListener("click", () => {
          dlBtn.disabled = true;
          dlBtn.textContent = "Downloading… 0%";
          void prepareMt(target, (p: MtProgress) => {
            if (p.status === "progress" && typeof p.progress === "number") {
              dlBtn.textContent = `Downloading… ${Math.round(p.progress)}%`;
            }
          })
            .then(() => void run())
            .catch((err: unknown) => {
              console.warn("[Translate] model download failed:", err);
              dlBtn.disabled = false;
              dlBtn.textContent = "⚠ Download failed — retry";
            });
        });
        actions.appendChild(dlBtn);
      }

      if (actions.childElementCount > 0) body.appendChild(actions);
    } catch (err) {
      console.warn("[Translate] failed:", err);
      status.textContent = "Couldn't read the screen — see console for details.";
    } finally {
      // Resume the emulator once the compute is done (incl. the early
      // "no text" return and any error) — reading the result runs unpaused.
      onBusy?.(false);
    }
  }

  void run();
}
