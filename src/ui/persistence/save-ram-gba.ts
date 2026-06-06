import type { Gba } from "../../gba";
import { cartIdOfGba } from "./cart-id.js";
import { idbDelete, idbGet, idbPut, STORE_SAVE_RAM } from "./storage.js";

/**
 * Persist GBA SRAM / Flash / EEPROM backup bytes to IndexedDB.
 *
 * Records live in the same `save-ram` object store as GB saves, but
 * with a `gba:` prefix on the key (see `cart-id.ts`) so the two never
 * collide. The record shape is intentionally similar:
 *
 *   { id, ramBytes, kind, rtc? }
 *
 * `rtc` is the S-3511A's battery-backed sidecar (status register +
 * cart-set clock offset) for RTC carts — same role as the GB side's
 * MBC3 RTC sidecar. Without it, Boktai re-prompts for the clock on
 * every boot because the chip looks power-cycled.
 *
 * The optional `kind` field captures the backup type so a corrupted /
 * mismatched record (different cart writing the same id, very unlikely
 * given the CRC32 component) is detectable on load — we refuse to
 * restore when the type doesn't match.
 *
 * EEPROM records carry the chip's resolved size in `ramBytes.length`
 * (512 B or 8 KB); the EepromBackup picks the address width back up
 * from the length on `loadFrom`. If the cart hasn't yet exercised
 * EEPROM (so the device is still unsized), no record is written.
 */

interface GbaSaveRecord {
  id: string;
  ramBytes: Uint8Array;
  kind: "sram" | "flash64" | "flash128" | "eeprom";
  rtc?: { status: number; offsetMs: number };
}

/** Last-persisted RTC chip state per engine instance, so the periodic
 *  dirty-gated autosave also fires when only the clock state moved
 *  (the cart setting its clock doesn't touch backup bytes). */
const lastSavedRtc = new WeakMap<Gba, string>();

function rtcKeyOf(gba: Gba): string {
  const s = gba.rtc?.chipState;
  return s ? `${s.status}:${s.offsetMs}` : "";
}

export function isPersistable(gba: Gba): boolean {
  return gba.mem.sram !== null || gba.mem.flash !== null || gba.mem.eeprom !== null;
}

function currentKind(gba: Gba): GbaSaveRecord["kind"] | null {
  if (gba.mem.sram) return "sram";
  if (gba.mem.flash) return gba.backup.type === "flash128" ? "flash128" : "flash64";
  if (gba.mem.eeprom) return "eeprom";
  return null;
}

function currentBytes(gba: Gba): Uint8Array | null {
  if (gba.mem.sram) return gba.mem.sram.bytes;
  if (gba.mem.flash) return gba.mem.flash.bytes;
  // EEPROM is null-sized until the cart triggers autodetect; skip the
  // record entirely in that window (length === 0).
  if (gba.mem.eeprom && gba.mem.eeprom.size !== 0) return gba.mem.eeprom.bytes;
  return null;
}

function currentDirty(gba: Gba): boolean {
  return gba.mem.sram?.dirty ?? gba.mem.flash?.dirty ?? gba.mem.eeprom?.dirty ?? false;
}

function clearDirty(gba: Gba): void {
  gba.mem.sram?.clearDirty();
  gba.mem.flash?.clearDirty();
  gba.mem.eeprom?.clearDirty();
}

/** Restore any persisted backup bytes into the engine's live backup
 *  device. Returns true if anything was loaded. */
export async function load(gba: Gba): Promise<boolean> {
  if (!isPersistable(gba)) return false;
  const kind = currentKind(gba);
  if (!kind) return false;
  try {
    const rec = await idbGet<GbaSaveRecord>(STORE_SAVE_RAM, cartIdOfGba(gba));
    if (!rec || !rec.ramBytes) return false;
    if (rec.kind && rec.kind !== kind) {
      // A different backup device was persisted for this id — refuse to
      // load. With the cart-id CRC32 component this should be effectively
      // impossible; we keep the guard so a manual store edit can't put
      // the runtime into a wedged state.
      console.warn(`[Save:GBA] backup-kind mismatch (stored ${rec.kind}, cart ${kind}); ignoring`);
      return false;
    }
    if (gba.mem.sram) {
      gba.mem.sram.loadFrom(rec.ramBytes);
    } else if (gba.mem.flash) {
      gba.mem.flash.loadFrom(rec.ramBytes);
    } else if (gba.mem.eeprom) {
      gba.mem.eeprom.loadFrom(rec.ramBytes);
    }
    if (rec.rtc && gba.rtc) {
      gba.rtc.chipState = rec.rtc;
      lastSavedRtc.set(gba, rtcKeyOf(gba));
    }
    console.info(`[Save:GBA] restored ${rec.ramBytes.length} bytes (${kind})`);
    return true;
  } catch (err) {
    console.warn("[Save:GBA] failed to read save from IndexedDB:", err);
    return false;
  }
}

/** Write the cart's current backup bytes if dirty (or `force` is set,
 *  or the RTC chip state moved since the last write). */
export async function save(gba: Gba, force = false): Promise<boolean> {
  if (!isPersistable(gba)) return false;
  const rtcDirty = gba.rtc !== null && lastSavedRtc.get(gba) !== rtcKeyOf(gba);
  if (!force && !currentDirty(gba) && !rtcDirty) return false;
  const kind = currentKind(gba);
  const bytes = currentBytes(gba);
  if (!kind || !bytes) return false;
  const rec: GbaSaveRecord = {
    id: cartIdOfGba(gba),
    // Copy so subsequent emulator writes don't race with the IDB put.
    ramBytes: new Uint8Array(bytes),
    kind,
    ...(gba.rtc ? { rtc: gba.rtc.chipState } : {})
  };
  try {
    await idbPut(STORE_SAVE_RAM, rec);
    clearDirty(gba);
    if (gba.rtc) lastSavedRtc.set(gba, rtcKeyOf(gba));
    return true;
  } catch (err) {
    console.warn("[Save:GBA] failed to write save to IndexedDB:", err);
    return false;
  }
}

/** Delete the persisted save for a cart entirely AND zero the live
 *  backup bytes so the running cart sees a fresh save immediately
 *  without a reload. Used by the Cart-Info "Clear save" button. */
export async function clear(gba: Gba): Promise<void> {
  try {
    await idbDelete(STORE_SAVE_RAM, cartIdOfGba(gba));
  } catch {
    /* ignore — clearing should succeed even if there was nothing to delete */
  }
  // Zero the live device too. The cart already has the backup mapped
  // and writes/reads against it; wiping IDB without zeroing the live
  // bytes would mean the user sees the old state until they save and
  // reload the cart. Use the live arrays so the next emulator read
  // (which races with this clear by single event-loop tick) sees zeros.
  if (gba.mem.sram) gba.mem.sram.bytes.fill(0);
  if (gba.mem.flash) gba.mem.flash.bytes.fill(0);
  if (gba.mem.eeprom && gba.mem.eeprom.size !== 0) gba.mem.eeprom.bytes.fill(0);
  clearDirty(gba);
}

/** Return the cart's current backup bytes for export to a file. Returns
 *  null when the cart has no backup or EEPROM hasn't been autodetected
 *  yet. The returned array is a copy — safe to ship to disk while the
 *  emulator continues writing. */
export function exportBytes(gba: Gba): Uint8Array | null {
  const live = currentBytes(gba);
  return live ? new Uint8Array(live) : null;
}

/** Overwrite the cart's backup bytes from an imported file and persist
 *  to IDB. Refuses if the byte count doesn't match the cart's backup
 *  size — the user almost certainly grabbed the wrong .sav file. */
export async function importBytes(gba: Gba, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isPersistable(gba)) return { ok: false, reason: "Cart has no backup memory." };
  const kind = currentKind(gba);
  if (!kind) return { ok: false, reason: "Backup device not initialised." };
  const live = currentBytes(gba);
  if (!live) return { ok: false, reason: "Backup device not initialised." };
  if (bytes.length !== live.length) {
    return {
      ok: false,
      reason: `Wrong size: cart expects ${live.length} bytes, file has ${bytes.length}.`
    };
  }
  if (gba.mem.sram) gba.mem.sram.loadFrom(bytes);
  else if (gba.mem.flash) gba.mem.flash.loadFrom(bytes);
  else if (gba.mem.eeprom) gba.mem.eeprom.loadFrom(bytes);
  // Force-write to IDB so a refresh restores the imported bytes — the
  // dirty-check would otherwise short-circuit, since the backup device
  // doesn't flag the post-loadFrom state as dirty.
  await save(gba, /* force */ true);
  return { ok: true };
}
