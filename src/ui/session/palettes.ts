/**
 * Curated DMG palette presets.
 *
 * Only meaningful for DMG carts; CGB-enhanced carts drive their own
 * palette RAM. Each entry supplies three 4-colour tables (background,
 * OBP0, OBP1) encoded as little-endian 32-bit RGBA — the same format the
 * PPU writes directly into its framebuffer.
 *
 * The names roughly track the CGB boot ROM's built-in palettes (Pan Docs
 * "DMG compatibility palettes") so users accustomed to the real hardware
 * can find familiar looks, plus a few design-matched accents.
 */

import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";

export interface DmgPalette {
  id: string;
  name: string;
  bg: readonly number[]; // 4 entries, lightest → darkest
  obp0: readonly number[];
  obp1: readonly number[];
}

/** LE-u32 "AABBGGRR" helper: takes 0xRRGGBB and returns the matching
 *  little-endian 32-bit RGBA value used by the framebuffer. */
const rgb = (hex: number): number =>
  0xff000000 | ((hex & 0x0000ff) << 16) | (hex & 0x00ff00) | ((hex & 0xff0000) >>> 16);

function mono(lightest: number, c1: number, c2: number, darkest: number): number[] {
  return [rgb(lightest), rgb(c1), rgb(c2), rgb(darkest)];
}

/** Default palette used when no preference is stored. Chosen to match the
 *  aurora theme's palette. */
export const DEFAULT_PALETTE_ID = "aurora";

export const PALETTES: readonly DmgPalette[] = [
  {
    id: "aurora",
    name: "Aurora",
    bg: mono(0xffffff, 0x7bb8ff, 0x2963a9, 0x000000),
    obp0: mono(0xffffff, 0x8383ff, 0x2929a9, 0x000000),
    obp1: mono(0xffffff, 0x83ff83, 0x29a929, 0x000000)
  },
  {
    id: "green",
    name: "Classic Green",
    bg: mono(0xd0f8e0, 0x70c088, 0x566834, 0x201808),
    obp0: mono(0xd0f8e0, 0x70c088, 0x566834, 0x201808),
    obp1: mono(0xd0f8e0, 0x70c088, 0x566834, 0x201808)
  },
  {
    id: "pocket",
    name: "Pocket",
    bg: mono(0xffffff, 0xaaaaaa, 0x555555, 0x000000),
    obp0: mono(0xffffff, 0xaaaaaa, 0x555555, 0x000000),
    obp1: mono(0xffffff, 0xaaaaaa, 0x555555, 0x000000)
  },
  {
    id: "light",
    name: "Game Boy Light",
    bg: mono(0xfff6a6, 0xe3bc5b, 0x8c6b22, 0x3a2a0a),
    obp0: mono(0xfff6a6, 0xe3bc5b, 0x8c6b22, 0x3a2a0a),
    obp1: mono(0xfff6a6, 0xe3bc5b, 0x8c6b22, 0x3a2a0a)
  },
  {
    id: "sgb",
    name: "SGB Default",
    bg: mono(0xf8e8c8, 0xd89048, 0xa82820, 0x301850),
    obp0: mono(0xf8d8b0, 0xffa060, 0xc03838, 0x402808),
    obp1: mono(0xf8d8b0, 0xffa060, 0xc03838, 0x402808)
  },
  {
    id: "blue",
    name: "Cool Blue",
    bg: mono(0xeef7ff, 0x94b7ff, 0x3660a0, 0x0a1032),
    obp0: mono(0xffffff, 0x8ed4ff, 0x3864b4, 0x0e1834),
    obp1: mono(0xffffff, 0xb6ffe6, 0x2e7a72, 0x081e1e)
  },
  {
    id: "pink",
    name: "Bubblegum",
    bg: mono(0xffe9f2, 0xff9ec7, 0xb04878, 0x440a28),
    obp0: mono(0xffffff, 0xffc6d3, 0xd05a88, 0x3c0820),
    obp1: mono(0xffffff, 0xffe6b8, 0xd89a3c, 0x402410)
  },
  {
    id: "gold",
    name: "Royal Gold",
    bg: mono(0xfff6c8, 0xe3c064, 0x9b6f1b, 0x2d1a06),
    obp0: mono(0xffffff, 0xffd368, 0xb26a1f, 0x2a160c),
    obp1: mono(0xffffff, 0xc8eac8, 0x468a48, 0x0a2410)
  },
  {
    id: "mono",
    name: "Ink",
    bg: mono(0xf4ece4, 0xb8a494, 0x6c5c50, 0x1a130d),
    obp0: mono(0xf4ece4, 0xb8a494, 0x6c5c50, 0x1a130d),
    obp1: mono(0xf4ece4, 0xb8a494, 0x6c5c50, 0x1a130d)
  }
];

export function findPalette(id: string): DmgPalette | undefined {
  return PALETTES.find((p) => p.id === id);
}

// ─── Persistence ──────────────────────────────────────────────────────────

export function loadPaletteId(): string {
  return lsGet(KEYS.PALETTE) || DEFAULT_PALETTE_ID;
}

export function savePaletteId(id: string): void {
  lsSet(KEYS.PALETTE, id);
}
