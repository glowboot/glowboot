import type { Cartridge } from "../../gb";
import { type Gba, parseGbaHeader } from "../../gba";
import { crc32 } from "./crc32.js";

/**
 * Stable per-cart IDB key — keys every persistence store (save-ram,
 * save-state, cheats, recents/library). Grep-friendly in DevTools'
 * IndexedDB viewer.
 *
 * Scheme:  `<title>:<headerChecksum>:<romCrc32>`        (GB / GBC)
 *          `gba:<title>:<gameCode>:<hdrChk>:<romCrc32>` (GBA)
 *
 * The CRC32 suffix exists so patched ROMs (IPS / BPS hacks, translations,
 * randomizers) get a different id from their vanilla base — without it,
 * auto-state / save-RAM collide and loading the unpatched cart resumes
 * inside the patched game.
 *
 * The `gba:` prefix on the GBA key prevents collisions if a GBA cart and
 * a GB cart happen to share a title — they would otherwise hash to the
 * same id and a GBA load would clobber a real GB save.
 */
export function cartIdOf(cart: Cartridge): string {
  const safeTitle = cart.title.replace(/[^A-Za-z0-9 _.-]/g, "_").trim() || "untitled";
  const header = cart.globalChecksum.toString(16).padStart(4, "0");
  const rom = romCrcCached(cart).toString(16).padStart(8, "0");
  return `${safeTitle}:${header}:${rom}`;
}

/** GBA equivalent — keys a Gba engine by its ROM identity. The `gba:`
 *  prefix namespaces these records away from GB cart ids in the shared
 *  save-ram store. */
export function cartIdOfGba(gba: Gba): string {
  const header = parseGbaHeader(gba.mem.rom);
  const safeTitle = header.title.replace(/[^A-Za-z0-9 _.-]/g, "_").trim() || "untitled";
  const code = header.gameCode.replace(/[^A-Za-z0-9]/g, "_") || "____";
  const hdr = header.headerChecksum.toString(16).padStart(2, "0");
  const rom = gbaRomCrcCached(gba).toString(16).padStart(8, "0");
  return `gba:${safeTitle}:${code}:${hdr}:${rom}`;
}

const romCrcCache = new WeakMap<Cartridge, number>();

function romCrcCached(cart: Cartridge): number {
  const cached = romCrcCache.get(cart);
  if (cached !== undefined) return cached;
  const value = crc32(cart.rom);
  romCrcCache.set(cart, value);
  return value;
}

const gbaRomCrcCache = new WeakMap<Gba, number>();

function gbaRomCrcCached(gba: Gba): number {
  const cached = gbaRomCrcCache.get(gba);
  if (cached !== undefined) return cached;
  const value = crc32(gba.mem.rom);
  gbaRomCrcCache.set(gba, value);
  return value;
}
