import type { Cartridge, CheatEntry } from "../../gb";
import type { Gba, GbaCheatEntry } from "../../gba";
import type { CheatEntry as NesCheatEntry, Nes } from "../../nes";
import type { CheatEntry as SnesCheatEntry, Snes } from "../../snes";
import { cartIdOf, cartIdOfGba, cartIdOfNes, cartIdOfSnes } from "./cart-id.js";
import { idbDelete, idbGet, idbPut, STORE_CHEATS } from "./storage.js";

/**
 * Per-cart cheat persistence. One IDB record per cartridge, keyed by the
 * shared `cartId` (sanitised title + 16-bit global checksum) — the same
 * identifier used for save RAM and save states. Cheats carry no sensitive
 * data so the format is just a plain array of cheat-entry objects.
 *
 * Engine awareness: GB and GBA carts use different entry shapes (GB has
 * `format` + optional `compare`; GBA has `width`). The cartId namespaces
 * are disjoint (`gba:` prefix on GBA ids), so the records never collide
 * in the shared store — each load returns entries of the right shape
 * for the cart that asked.
 */

interface CheatRecord<E> {
  cartId: string;
  entries: E[];
}

export async function load(cart: Cartridge): Promise<CheatEntry[]> {
  try {
    const rec = await idbGet<CheatRecord<CheatEntry>>(STORE_CHEATS, cartIdOf(cart));
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
    const rec: CheatRecord<CheatEntry> = { cartId: cartIdOf(cart), entries: entries.map((e) => ({ ...e })) };
    await idbPut(STORE_CHEATS, rec);
  } catch (err) {
    console.warn("[Cheats] save failed:", err);
  }
}

export async function loadGba(gba: Gba): Promise<GbaCheatEntry[]> {
  try {
    const rec = await idbGet<CheatRecord<GbaCheatEntry>>(STORE_CHEATS, cartIdOfGba(gba));
    return rec?.entries ?? [];
  } catch (err) {
    console.warn("[Cheats] load (GBA) failed:", err);
    return [];
  }
}

export async function saveGba(gba: Gba, entries: readonly GbaCheatEntry[]): Promise<void> {
  try {
    if (entries.length === 0) {
      await idbDelete(STORE_CHEATS, cartIdOfGba(gba));
      return;
    }
    const rec: CheatRecord<GbaCheatEntry> = {
      cartId: cartIdOfGba(gba),
      entries: entries.map((e) => ({ ...e }))
    };
    await idbPut(STORE_CHEATS, rec);
  } catch (err) {
    console.warn("[Cheats] save (GBA) failed:", err);
  }
}

export async function loadNes(nes: Nes): Promise<NesCheatEntry[]> {
  try {
    const rec = await idbGet<CheatRecord<NesCheatEntry>>(STORE_CHEATS, cartIdOfNes(nes));
    return rec?.entries ?? [];
  } catch (err) {
    console.warn("[Cheats] load (NES) failed:", err);
    return [];
  }
}

export async function saveNes(nes: Nes, entries: readonly NesCheatEntry[]): Promise<void> {
  try {
    if (entries.length === 0) {
      await idbDelete(STORE_CHEATS, cartIdOfNes(nes));
      return;
    }
    const rec: CheatRecord<NesCheatEntry> = {
      cartId: cartIdOfNes(nes),
      entries: entries.map((e) => ({ ...e }))
    };
    await idbPut(STORE_CHEATS, rec);
  } catch (err) {
    console.warn("[Cheats] save (NES) failed:", err);
  }
}

export async function loadSnes(snes: Snes): Promise<SnesCheatEntry[]> {
  try {
    const rec = await idbGet<CheatRecord<SnesCheatEntry>>(STORE_CHEATS, cartIdOfSnes(snes));
    return rec?.entries ?? [];
  } catch (err) {
    console.warn("[Cheats] load (SNES) failed:", err);
    return [];
  }
}

export async function saveSnes(snes: Snes, entries: readonly SnesCheatEntry[]): Promise<void> {
  try {
    if (entries.length === 0) {
      await idbDelete(STORE_CHEATS, cartIdOfSnes(snes));
      return;
    }
    const rec: CheatRecord<SnesCheatEntry> = {
      cartId: cartIdOfSnes(snes),
      entries: entries.map((e) => ({ ...e }))
    };
    await idbPut(STORE_CHEATS, rec);
  } catch (err) {
    console.warn("[Cheats] save (SNES) failed:", err);
  }
}
