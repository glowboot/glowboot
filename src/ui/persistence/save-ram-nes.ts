import type { Nes } from "../../nes";
import { cartIdOfNes } from "./cart-id.js";
import { idbDelete, idbGet, idbPut, STORE_SAVE_RAM } from "./storage.js";

/**
 * Persist NES battery-backed PRG-RAM ($6000-$7FFF) to IndexedDB.
 *
 * Records share the `save-ram` object store with GB/GBA saves; the `nes:`
 * cart-id prefix (see `cart-id.ts`) keeps the namespaces disjoint. Only carts
 * whose iNES header sets the battery flag persist — everything else has
 * volatile work RAM that shouldn't survive a reload.
 *
 * Simpler than the GB/GBA modules: the NES cart has a single battery slice,
 * no RTC sidecar, and no multiple backup-device kinds. The cart exposes no
 * dirty flag, so the periodic autosave compares against the last-written
 * snapshot to avoid re-writing unchanged RAM every tick.
 */

interface NesSaveRecord {
  id: string;
  ramBytes: Uint8Array;
}

const lastSaved = new WeakMap<Nes, Uint8Array>();

export function isPersistable(nes: Nes): boolean {
  return nes.hasBattery && nes.batteryRam !== null;
}

function changedSinceSave(nes: Nes, bytes: Uint8Array): boolean {
  const prev = lastSaved.get(nes);
  if (!prev || prev.length !== bytes.length) return true;
  for (let i = 0; i < bytes.length; i++) if (prev[i] !== bytes[i]) return true;
  return false;
}

/** Restore persisted battery RAM into the live cart. Returns true if loaded. */
export async function load(nes: Nes): Promise<boolean> {
  if (!isPersistable(nes)) return false;
  try {
    const rec = await idbGet<NesSaveRecord>(STORE_SAVE_RAM, cartIdOfNes(nes));
    if (!rec || !rec.ramBytes) return false;
    nes.loadBatteryRam(rec.ramBytes);
    lastSaved.set(nes, new Uint8Array(rec.ramBytes));
    console.info(`[Save:NES] restored ${rec.ramBytes.length} bytes`);
    return true;
  } catch (err) {
    console.warn("[Save:NES] failed to read save from IndexedDB:", err);
    return false;
  }
}

/** Write the cart's battery RAM if it changed since the last write (or `force`). */
export async function save(nes: Nes, force = false): Promise<boolean> {
  if (!isPersistable(nes)) return false;
  const bytes = nes.batteryRam;
  if (!bytes) return false;
  if (!force && !changedSinceSave(nes, bytes)) return false;
  const rec: NesSaveRecord = { id: cartIdOfNes(nes), ramBytes: new Uint8Array(bytes) };
  try {
    await idbPut(STORE_SAVE_RAM, rec);
    lastSaved.set(nes, new Uint8Array(bytes));
    return true;
  } catch (err) {
    console.warn("[Save:NES] failed to write save to IndexedDB:", err);
    return false;
  }
}

/** Delete the persisted save and zero the live battery RAM so the running cart
 *  sees a fresh save immediately without a reload. */
export async function clear(nes: Nes): Promise<void> {
  try {
    await idbDelete(STORE_SAVE_RAM, cartIdOfNes(nes));
  } catch {
    /* ignore — clearing should succeed even if there was nothing to delete */
  }
  nes.batteryRam?.fill(0);
  lastSaved.delete(nes);
}

/** The cart's current battery bytes for export to a file (a copy), or null. */
export function exportBytes(nes: Nes): Uint8Array | null {
  const live = nes.batteryRam;
  return live ? new Uint8Array(live) : null;
}

/** Overwrite battery RAM from an imported file and persist. Refuses on a size
 *  mismatch — the user almost certainly grabbed the wrong .sav file. */
export async function importBytes(nes: Nes, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }> {
  const live = nes.batteryRam;
  if (!isPersistable(nes) || !live) return { ok: false, reason: "Cart has no battery save." };
  if (bytes.length !== live.length) {
    return {
      ok: false,
      reason: `Wrong size: cart expects ${live.length} bytes, file has ${bytes.length}.`
    };
  }
  nes.loadBatteryRam(bytes);
  await save(nes, /* force */ true);
  return { ok: true };
}
