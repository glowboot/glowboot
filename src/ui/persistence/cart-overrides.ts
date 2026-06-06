import type { AudioMode } from "../audio/output.js";
import { idbDelete, idbGet, idbPut, STORE_CART_OVERRIDES } from "./storage.js";

/**
 * Per-cart settings overrides — let a specific game pin a palette / CGB
 * colour correction / render mode that differs from the user's global
 * preference. Only the fields the user explicitly pinned are stored;
 * everything else falls through to the global localStorage default.
 *
 * Persisted in IndexedDB keyed by the cart id helper (`cartIdOf` for
 * GB carts, `cartIdOfGba` for GBA — caller's choice), mirroring the
 * save-RAM / save-states / cheats stores. Patched ROMs get their own
 * overrides independent of the vanilla base. Functions take the id
 * directly so this layer stays engine-agnostic.
 */
export interface CartOverrides {
  /** DMG palette id (as returned by `Palettes.PALETTES[i].id`). Only
   *  meaningful for DMG carts; CGB carts drive their own palette RAM. */
  palette?: string;
  /** CGB colour-correction pref. Only meaningful for CGB carts. */
  colorCorrection?: boolean;
  /** Render-mode key (as used in the settings dropdown: `canvas`,
   *  `webgl-mmpx`, ...). Changing this live swaps the canvas + renderer. */
  renderMode?: string;
  /** Integer-scaling pref — whether the canvas is sized to a whole-
   *  number multiple of the engine's native frame (160×144 for Game
   *  Boy, 240×160 for Game Boy Advance). Default is OFF so the
   *  240×160 GBA frame fills more of the viewport; users who prefer
   *  sharp per-pixel scaling (best fit for the 160×144 Game Boy
   *  frame) can flip it on globally or per cart. */
  integerScale?: boolean;
  /** Pixel-response blend factor in [0, 0.85]. Higher values simulate
   *  stronger LCD persistence and smooth 30 Hz flicker in specific
   *  games (e.g. Pokémon title screen, Link's Awakening rain). */
  pixelResponse?: number;
  /** Audio mode id (see `AUDIO_MODES`). Lets a chiptune-heavy game pin
   *  a different EQ / reverb than the global default — e.g. hall-reverb
   *  for Donkey Kong Country's ambient tracks while leaving everything
   *  else clean. */
  audioMode?: AudioMode;
}

interface CartOverridesRecord {
  cartId: string;
  overrides: CartOverrides;
}

/** Load overrides for a cart id. Returns an empty object if none
 *  are persisted — the caller treats "no override" and "no record"
 *  the same way, so null wouldn't add signal. */
export async function loadCartOverrides(cartId: string): Promise<CartOverrides> {
  try {
    const rec = await idbGet<CartOverridesRecord>(STORE_CART_OVERRIDES, cartId);
    return rec?.overrides ?? {};
  } catch (err) {
    console.warn("[CartOverrides] load failed:", err);
    return {};
  }
}

/** Persist the full overrides object, or delete the record when
 *  everything's been cleared so the store doesn't accumulate empty
 *  entries over time. */
export async function saveCartOverrides(cartId: string, overrides: CartOverrides): Promise<void> {
  const hasAny = Object.values(overrides).some((v) => v !== undefined);
  try {
    if (hasAny) await idbPut(STORE_CART_OVERRIDES, { cartId, overrides });
    else await idbDelete(STORE_CART_OVERRIDES, cartId);
  } catch (err) {
    console.warn("[CartOverrides] save failed:", err);
  }
}
