/**
 * Engine adapter — a thin, uniform handle over whichever console core is
 * running, so the browser shell can do the generic things (read the
 * framebuffer, know the platform) without a `gb` / `gba` / `nes` branch at
 * every call site. The concrete `state.gb` / `state.gba` / `state.nes` fields
 * stay for the genuinely engine-specific deep reaches (debugger panes, GBA
 * sensors, GB camera); this only absorbs the parts that are the same shape
 * across engines.
 *
 * Adapters are intentionally thin pass-throughs — cart-id derivation, save
 * states, and save-RAM persistence stay in their existing modules and are
 * delegated to, never reimplemented, so the shipped GB/GBA data formats are
 * untouched.
 */

import type { GameBoy } from "../../gb";
import type { Gba } from "../../gba";
import type { Nes } from "../../nes";
import { type EngineId, type Platform, PLATFORMS } from "./platform.js";

/** Any of the three console cores. Narrow via `adapter.id` when a deep reach
 *  genuinely needs the concrete type. */
export type AnyEngine = GameBoy | Gba | Nes;

export interface EngineAdapter {
  readonly id: EngineId;
  readonly platform: Platform;
  /** The wrapped core, for engine-specific reaches after narrowing on `id`. */
  readonly engine: AnyEngine;
  /** The core's current RGBA framebuffer, sized to `platform.screen`. */
  readonly framebuffer: Uint8ClampedArray<ArrayBuffer>;
}

export function makeGbAdapter(gb: GameBoy): EngineAdapter {
  return {
    id: "gb",
    platform: PLATFORMS.gb,
    engine: gb,
    get framebuffer() {
      return gb.ppu.framebuffer;
    }
  };
}

export function makeGbaAdapter(gba: Gba): EngineAdapter {
  return {
    id: "gba",
    platform: PLATFORMS.gba,
    engine: gba,
    get framebuffer() {
      return gba.framebuffer;
    }
  };
}

export function makeNesAdapter(nes: Nes): EngineAdapter {
  return {
    id: "nes",
    platform: PLATFORMS.nes,
    engine: nes,
    get framebuffer() {
      return nes.framebuffer;
    }
  };
}
