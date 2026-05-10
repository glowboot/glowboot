import type { CartOverrides } from "../persistence/cart-overrides.js";
import { KEYS, lsGet } from "../persistence/local-storage.js";
import { renderer, state, swapRenderer } from "../state.js";
import * as Palettes from "./palettes.js";

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
 * This runs after the global prefs have already been re-applied in
 * `rom-loader.ts`, so we can overwrite freely.
 */
export function applyCartOverrides(overrides: CartOverrides): void {
  const gb = state.gb;
  if (!gb) return;

  // ── Palette (DMG only) ─────────────────────────────────────────────
  // CGB carts drive their own palette RAM, so per-cart palette pinning
  // only makes sense for DMG games. Skip silently on CGB.
  if (!gb.cart.cgb) {
    const paletteId = overrides.palette ?? Palettes.loadPaletteId();
    const p = Palettes.findPalette(paletteId) ?? Palettes.findPalette(Palettes.DEFAULT_PALETTE_ID);
    if (p) gb.ppu.setDmgCompatPalette(p.bg, p.obp0, p.obp1);
  }

  // ── CGB colour correction ──────────────────────────────────────────
  const cc = overrides.colorCorrection ?? lsGet(KEYS.COLOR_CORRECTION) !== "0";
  gb.ppu.colorCorrection = cc;

  // ── Render mode ────────────────────────────────────────────────────
  // Swap only when the mode actually differs — swapping destroys the
  // current canvas element, so no-op swaps would flicker.
  const wantedMode = overrides.renderMode ?? lsGet(KEYS.RENDER_MODE) ?? "webgl-mmpx";
  const currentMode = rendererModeOf(renderer);
  const didSwap = wantedMode !== currentMode;
  if (didSwap) swapRenderer(wantedMode);

  // ── Integer scaling + pixel response ───────────────────────────────
  // Applied after the potential swap, on every invocation, so per-cart
  // pins for these fields take effect even when the render mode didn't
  // change. Falls through to the global localStorage values when the
  // user hasn't pinned an override.
  const integerOn = overrides.integerScale ?? lsGet(KEYS.INTEGER_SCALE) !== "0";
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
  if (didSwap && state.gb) renderer.render(state.gb.ppu.framebuffer);
}

/** Inverse of `shaderForMode` in state.ts — tells us which dropdown
 *  key matches the renderer instance currently on the DOM, so
 *  `applyCartOverrides` can skip a no-op swap. */
function rendererModeOf(r: unknown): string {
  const name = (r as { shaderName?: string }).shaderName;
  if (!name) return "canvas";
  return `webgl-${name}`;
}
