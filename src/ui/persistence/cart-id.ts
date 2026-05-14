import type { Cartridge } from "../../gb";
import { crc32 } from "./crc32.js";

/**
 * Stable per-cart IDB key — keys every persistence store (save-ram,
 * save-state, cheats, recents/library). Grep-friendly in DevTools'
 * IndexedDB viewer.
 *
 * Scheme:  `<title>:<headerChecksum>:<romCrc32>`
 *
 * The CRC32 suffix exists so patched ROMs (IPS / BPS hacks, translations,
 * randomizers) get a different id from their vanilla base — without it,
 * auto-state / save-RAM collide and loading the unpatched cart resumes
 * inside the patched game.
 */
export function cartIdOf(cart: Cartridge): string {
  const safeTitle = cart.title.replace(/[^A-Za-z0-9 _.-]/g, "_").trim() || "untitled";
  const header = cart.globalChecksum.toString(16).padStart(4, "0");
  const rom = romCrcCached(cart).toString(16).padStart(8, "0");
  return `${safeTitle}:${header}:${rom}`;
}

const romCrcCache = new WeakMap<Cartridge, number>();

function romCrcCached(cart: Cartridge): number {
  const cached = romCrcCache.get(cart);
  if (cached !== undefined) return cached;
  const value = crc32(cart.rom);
  romCrcCache.set(cart, value);
  return value;
}
