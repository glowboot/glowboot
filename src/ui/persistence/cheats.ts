import type { Cartridge, CheatEntry } from "../../gb";
import { cartIdOf } from "./cart-id.js";
import { idbDelete, idbGet, idbPut, STORE_CHEATS } from "./storage.js";

/**
 * Per-cart cheat persistence. One IDB record per cartridge, keyed by the
 * shared `cartId` (sanitised title + 16-bit global checksum) — the same
 * identifier used for save RAM and save states. Cheats carry no sensitive
 * data so the format is just a plain array of `CheatEntry` objects.
 */

interface CheatRecord {
  cartId: string;
  entries: CheatEntry[];
}

export async function load(cart: Cartridge): Promise<CheatEntry[]> {
  try {
    const rec = await idbGet<CheatRecord>(STORE_CHEATS, cartIdOf(cart));
    return rec?.entries ?? [];
  } catch (err) {
    console.warn("[Cheats] load failed:", err);
    return [];
  }
}

export async function save(cart: Cartridge, entries: readonly CheatEntry[]): Promise<void> {
  try {
    if (entries.length === 0) {
      await idbDelete(STORE_CHEATS, cartIdOf(cart));
      return;
    }
    const rec: CheatRecord = { cartId: cartIdOf(cart), entries: entries.map((e) => ({ ...e })) };
    await idbPut(STORE_CHEATS, rec);
  } catch (err) {
    console.warn("[Cheats] save failed:", err);
  }
}
