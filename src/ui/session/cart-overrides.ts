import { AUDIO_MODES, type AudioMode } from "../audio/output.js";
import type { CartOverrides } from "../persistence/cart-overrides.js";
import { KEYS, lsGet } from "../persistence/local-storage.js";
import { loadIntegerScalePref } from "../settings";
import { audio, renderer, state, swapRenderer } from "../state.js";
import * as Palettes from "./palettes.js";

const VALID_AUDIO_MODES = new Set<string>(AUDIO_MODES.map((m) => m.id));

function clampPixelResponse(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(0.85, v)) : 0;
}

/**
 * Apply a cart's persisted overrides on top of the user's global
 * preferences so the game launches looking / behaving the way the user
 * last pinned it for *that* cart. Missing fields fall through to the
 * global localStorage defaults — calling `applyCartOverrides({})`
 * effectively resets every override to the global value.
 *
 * Engine awareness: palette + CGB colour-correction target the GB PPU
 * directly and are no-ops on GBA. Renderer pins (render mode, integer
 * scale, pixel response) and audio mode apply to both engines through
 * the shared renderer / audio-output abstractions.
 *
 * Runs after the global prefs have already been re-applied in
 * `rom-loader.ts`, so we can overwrite freely.
 */
export function applyCartOverrides(overrides: CartOverrides): void {
  const gb = state.gb;
  const gba = state.gba;
  if (!gb && !gba) return;

  if (gb && !gb.cart.cgb) {
    // ── Palette (DMG only) ───────────────────────────────────────────
    // CGB carts drive their own palette RAM, so per-cart palette pinning
    // only makes sense for DMG games. Skip silently on CGB and GBA.
    const paletteId = overrides.palette ?? Palettes.loadPaletteId();
    const p = Palettes.findPalette(paletteId) ?? Palettes.findPalette(Palettes.DEFAULT_PALETTE_ID);
    if (p) gb.ppu.setDmgCompatPalette(p.bg, p.obp0, p.obp1);
  }

  if (gb) {
    // ── CGB colour correction ────────────────────────────────────────
    const cc = overrides.colorCorrection ?? lsGet(KEYS.COLOR_CORRECTION) !== "0";
    gb.ppu.colorCorrection = cc;
  }

  // ── Render mode ────────────────────────────────────────────────────
  // Swap only when the mode actually differs — swapping destroys the
  // current canvas element, so no-op swaps would flicker. The renderer
  // abstraction handles both engines; the dims come from the active
  // engine inside `swapRenderer`.
  const wantedMode = overrides.renderMode ?? lsGet(KEYS.RENDER_MODE) ?? "canvas";
  const currentMode = rendererModeOf(renderer);
  const didSwap = wantedMode !== currentMode;
  if (didSwap) swapRenderer(wantedMode);

  // ── Integer scaling + pixel response ───────────────────────────────
  // Applied after the potential swap, on every invocation, so per-cart
  // pins for these fields take effect even when the render mode didn't
  // change. Falls through to the global localStorage values when the
  // user hasn't pinned an override.
  const integerOn = overrides.integerScale ?? loadIntegerScalePref();
  renderer.integerScale = integerOn;
  const rawResp =
    overrides.pixelResponse ??
    (() => {
      const s = parseFloat(lsGet(KEYS.PIXEL_RESPONSE) ?? "0");
      return Number.isFinite(s) ? s : 0;
    })();
  renderer.setPixelResponse(clampPixelResponse(rawResp));

  // Repaint the current frame on a fresh renderer so the swap doesn't
  // expose an empty canvas while the engine is paused.
  if (didSwap) {
    if (gb) renderer.render(gb.ppu.framebuffer);
    else if (gba) renderer.render(gba.framebuffer);
  }

  // ── Audio mode ───────────────────────────────────────────────────────
  // Web Audio output graph is engine-agnostic — applies to both GB and
  // GBA. Set on every invocation so loading a cart without an override
  // snaps the global filter chain back into place after a previous
  // cart had one pinned. The Set lookup defends against an old IDB
  // record that names a mode id this build no longer ships.
  const wantedAudio = overrides.audioMode ?? lsGet(KEYS.AUDIO_MODE) ?? "studio";
  const audioMode: AudioMode = VALID_AUDIO_MODES.has(wantedAudio) ? (wantedAudio as AudioMode) : "studio";
  audio.setAudioMode(audioMode);
}

/** Inverse of `shaderForMode` in state.ts — tells us which dropdown
 *  key matches the renderer instance currently on the DOM, so
 *  `applyCartOverrides` can skip a no-op swap. */
function rendererModeOf(r: unknown): string {
  const name = (r as { shaderName?: string }).shaderName;
  if (!name) return "canvas";
  return `webgl-${name}`;
}
