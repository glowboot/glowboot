import type { Snes } from "../../snes";
import { cartIdOfSnes } from "./cart-id.js";
import { idbDelete, idbGet, idbPut, STORE_SAVE_RAM } from "./storage.js";

/**
 * Persist NES battery-backed PRG-RAM ($6000-$7FFF) to IndexedDB.
 *
 * Records share the `save-ram` object store with GB/GBA saves; the `snes:`
 * cart-id prefix (see `cart-id.ts`) keeps the namespaces disjoint. Only carts
 * whose iNES header sets the battery flag persist — everything else has
 * volatile work RAM that shouldn't survive a reload.
 *
 * Simpler than the GB/GBA modules: the NES cart has a single battery slice,
 * no RTC sidecar, and no multiple backup-device kinds. The cart exposes no
 * dirty flag, so the periodic autosave compares against the last-written
 * snapshot to avoid re-writing unchanged RAM every tick.
 */

interface SnesSaveRecord {
  id: string;
  ramBytes: Uint8Array;
}

const lastSaved = new WeakMap<Snes, Uint8Array>();

export function isPersistable(snes: Snes): boolean {
  return snes.hasBattery && snes.batteryRam !== null;
}

function changedSinceSave(snes: Snes, bytes: Uint8Array): boolean {
  const prev = lastSaved.get(snes);
  if (!prev || prev.length !== bytes.length) return true;
  for (let i = 0; i < bytes.length; i++) if (prev[i] !== bytes[i]) return true;
  return false;
}

/** Restore persisted battery RAM into the live cart. Returns true if loaded. */
export async function load(snes: Snes): Promise<boolean> {
  if (!isPersistable(snes)) return false;
  try {
    const rec = await idbGet<SnesSaveRecord>(STORE_SAVE_RAM, cartIdOfSnes(snes));
    if (!rec || !rec.ramBytes) return false;
    snes.loadBatteryRam(rec.ramBytes);
    lastSaved.set(snes, new Uint8Array(rec.ramBytes));
    console.info(`[Save:NES] restored ${rec.ramBytes.length} bytes`);
    return true;
  } catch (err) {
    console.warn("[Save:NES] failed to read save from IndexedDB:", err);
    return false;
  }
}

/** Write the cart's battery RAM if it changed since the last write (or `force`). */
export async function save(snes: Snes, force = false): Promise<boolean> {
  if (!isPersistable(snes)) return false;
  const bytes = snes.batteryRam;
  if (!bytes) return false;
  if (!force && !changedSinceSave(snes, bytes)) return false;
  const rec: SnesSaveRecord = { id: cartIdOfSnes(snes), ramBytes: new Uint8Array(bytes) };
  try {
    await idbPut(STORE_SAVE_RAM, rec);
    lastSaved.set(snes, new Uint8Array(bytes));
    return true;
  } catch (err) {
    console.warn("[Save:NES] failed to write save to IndexedDB:", err);
    return false;
  }
}

/** Delete the persisted save and zero the live battery RAM so the running cart
 *  sees a fresh save immediately without a reload. */
export async function clear(snes: Snes): Promise<void> {
  try {
    await idbDelete(STORE_SAVE_RAM, cartIdOfSnes(snes));
  } catch {
    /* ignore — clearing should succeed even if there was nothing to delete */
  }
  snes.batteryRam?.fill(0);
  lastSaved.delete(snes);
}

/** The cart's current battery bytes for export to a file (a copy), or null. */
export function exportBytes(snes: Snes): Uint8Array | null {
  const live = snes.batteryRam;
  return live ? new Uint8Array(live) : null;
}

/** Overwrite battery RAM from an imported file and persist. Refuses on a size
 *  mismatch — the user almost certainly grabbed the wrong .sav file. */
export async function importBytes(
  snes: Snes,
  bytes: Uint8Array
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const live = snes.batteryRam;
  if (!isPersistable(snes) || !live) return { ok: false, reason: "Cart has no battery save." };
  if (bytes.length !== live.length) {
    return {
      ok: false,
      reason: `Wrong size: cart expects ${live.length} bytes, file has ${bytes.length}.`
    };
  }
  snes.loadBatteryRam(bytes);
  await save(snes, /* force */ true);
  return { ok: true };
}
