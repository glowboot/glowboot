import type { Cartridge } from "../../gb";
import { cartIdOf } from "./cart-id.js";
import { idbDelete, idbGet, idbPut, STORE_SAVE_RAM } from "./storage.js";

/**
 * Persist battery-backed external RAM (and, if applicable, the MBC3
 * real-time-clock sidecar) to IndexedDB so in-game saves survive page
 * reloads.
 *
 * Stored as one record per cart in the shared `save-ram` object store,
 * keyed by a stable cart identifier (sanitised title + 16-bit global
 * checksum). ROMs that share a title but differ in region/checksum get
 * their own record.
 */

interface SaveRamRecord {
  id: string;
  ramBytes?: Uint8Array; // omitted when cart has no battery-backed RAM (RTC-only)
  rtc?: string; // JSON blob produced by Cartridge.serializeRtc()
}

export function isPersistable(cart: Cartridge): boolean {
  // Anything with a battery that backs real data — either external RAM or
  // the MBC3 RTC (or both).
  return cart.hasBattery && (cart.ramBanks > 0 || cart.hasRtc);
}

/** Restore whatever's in IndexedDB for `cart` into its RAM + RTC fields.
 *  Returns true if anything was restored (ignores async failures and
 *  resolves with false on I/O errors so the caller can keep running). */
export async function load(cart: Cartridge): Promise<boolean> {
  if (!isPersistable(cart)) return false;
  try {
    const rec = await idbGet<SaveRamRecord>(STORE_SAVE_RAM, cartIdOf(cart));
    if (!rec) return false;
    let restored = false;
    if (rec.ramBytes && cart.ramBanks > 0) {
      cart.loadRam(rec.ramBytes);
      console.info(`[Save] restored ${rec.ramBytes.length} bytes for "${cart.title}"`);
      restored = true;
    }
    if (rec.rtc && cart.hasRtc) {
      cart.deserializeRtc(rec.rtc);
      console.info(`[Save] restored RTC state for "${cart.title}"`);
      restored = true;
    }
    return restored;
  } catch (err) {
    console.warn("[Save] failed to read save from IndexedDB:", err);
    return false;
  }
}

/**
 * Write current RAM (+ RTC sidecar) to IndexedDB if the cart is dirty or
 * `force` is set. Clears the dirty flag on success.
 *
 * Note: this is called every ~2 s from the autosave interval, so keep
 * the happy path cheap. For RTC-only carts we always write (the clock
 * ticks regardless of ramDirty); for RAM-only carts we honour the dirty
 * flag.
 */
export async function save(cart: Cartridge, force = false): Promise<boolean> {
  if (!isPersistable(cart)) return false;
  const hasDirtyRam = cart.ramBanks > 0 && (force || cart.ramDirty);
  const needsRtc = cart.hasRtc; // always worth re-writing; cheap
  if (!hasDirtyRam && !needsRtc) return false;

  const rec: SaveRamRecord = { id: cartIdOf(cart) };
  // Copy the bytes so subsequent emulator writes don't race with the IDB
  // put (the browser may snapshot the Uint8Array asynchronously).
  if (cart.ramBanks > 0) rec.ramBytes = new Uint8Array(cart.ram);
  if (cart.hasRtc) {
    const rtcJson = cart.serializeRtc();
    if (rtcJson) rec.rtc = rtcJson;
  }

  try {
    await idbPut(STORE_SAVE_RAM, rec);
    if (hasDirtyRam) cart.clearDirty();
    return true;
  } catch (err) {
    console.warn("[Save] failed to write save to IndexedDB:", err);
    return false;
  }
}

/** Remove the stored save for a cart entirely (RAM + RTC). Not currently
 *  wired from the UI, but useful for tests and a future "delete save"
 *  action. */
export async function remove(cart: Cartridge): Promise<void> {
  try {
    await idbDelete(STORE_SAVE_RAM, cartIdOf(cart));
  } catch {
    /* ignore */
  }
}
