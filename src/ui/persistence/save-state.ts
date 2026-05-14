import type { Cartridge, GameBoy } from "../../gb";
import { UnsupportedSaveStateError } from "../../gb/serialization/serialization.js";
import { errorToast } from "../hud/toast.js";
import { cartIdOf } from "./cart-id.js";
import { idbDelete, idbGet, idbGetAllByIndex, idbPut, STORE_SAVE_STATES } from "./storage.js";

/**
 * Save-state persistence for the `save-states` IndexedDB store. Every
 * record is keyed on "<cartId>:<slot>" and carries the cart id as a
 * separate `cartId` field so the UI can enumerate all slots for the
 * active cart via a single indexed query.
 *
 * The binary format itself (StateWriter / StateReader) lives in
 * `src/gb/serialization/serialization.ts`; this file only deals with
 * storage + slot bookkeeping.
 */

function recordId(cart: Cartridge, slot: number): string {
  return `${cartIdOf(cart)}:${slot}`;
}

interface StateRecord {
  id: string;
  cartId: string;
  slot: number;
  bytes: Uint8Array;
  savedAt: number;
  thumb?: string; // PNG data URL captured at save time
  label?: string; // user-entered short name ("Before Ganon", "Glitch setup")
}

/** How many save-state slots each cart gets (0..SLOT_COUNT-1). 12 fits
 *  neatly in the 4-col grid on desktop and the 3-col grid on phones,
 *  so the slot card sizes line up with the library across both
 *  layouts. Slots 0..9 are reachable via the digit-key shortcuts; the
 *  last two are popover-only. */
export const SLOT_COUNT = 12;

/** Private slot number used for the auto-snapshot. Negative so it lives in
 *  the same IDB store as user slots but can't collide with the
 *  0..SLOT_COUNT-1 range the UI exposes, and is filtered out of
 *  `listSlots`. */
const AUTO_SLOT = -1;

export async function saveStateTo(gb: GameBoy, slot = 0, thumb?: string): Promise<boolean> {
  try {
    const bytes = gb.saveState();
    // Preserve any user-entered label across re-saves into the same slot —
    // overwriting the state bytes shouldn't wipe the "Before Ganon" tag.
    const existing = await idbGet<StateRecord>(STORE_SAVE_STATES, recordId(gb.cart, slot));
    const rec: StateRecord = {
      id: recordId(gb.cart, slot),
      cartId: cartIdOf(gb.cart),
      slot,
      // Copy so the bytes aren't held through subsequent engine mutations.
      bytes: new Uint8Array(bytes),
      savedAt: Date.now(),
      ...(thumb ? { thumb } : {}),
      ...(existing?.label !== undefined ? { label: existing.label } : {})
    };
    try {
      await idbPut(STORE_SAVE_STATES, rec);
    } catch (err) {
      // If the write blew quota (typically because of a large thumbnail),
      // retry once without the thumbnail so the state itself still lands.
      if (rec.thumb) {
        delete rec.thumb;
        await idbPut(STORE_SAVE_STATES, rec);
      } else {
        throw err;
      }
    }
    return true;
  } catch (err) {
    console.warn("[State] save failed:", err);
    return false;
  }
}

export async function loadStateFrom(gb: GameBoy, slot = 0): Promise<boolean> {
  try {
    const rec = await idbGet<StateRecord>(STORE_SAVE_STATES, recordId(gb.cart, slot));
    if (!rec) return false;
    gb.loadState(rec.bytes);
    return true;
  } catch (err) {
    // Version-mismatch / migrator-missing failures get a user-readable
    // explanation; everything else falls through to a generic warning.
    if (err instanceof UnsupportedSaveStateError) errorToast(err.message);
    console.warn("[State] load failed:", err);
    return false;
  }
}

export async function hasState(cart: Cartridge, slot = 0): Promise<boolean> {
  try {
    const rec = await idbGet<StateRecord>(STORE_SAVE_STATES, recordId(cart, slot));
    return !!rec;
  } catch {
    return false;
  }
}

export interface SlotInfo {
  slot: number;
  savedAt: number; // epoch ms, 0 if unknown (legacy saves have no timestamp)
  bytes: number; // size of the serialized state blob
  thumb?: string; // PNG data URL if one was captured at save time
  label?: string; // user-entered short name for the slot
}

/** Enumerate every save slot that has data for `cart`. Empty slots are
 *  simply absent from the returned array. Async because the `save-states`
 *  store is in IndexedDB. Filters out the private auto-snapshot slot. */
export async function listSlots(cart: Cartridge): Promise<SlotInfo[]> {
  try {
    const recs = await idbGetAllByIndex<StateRecord>(STORE_SAVE_STATES, "cartId", cartIdOf(cart));
    return recs
      .filter((r) => r.slot >= 0)
      .map<SlotInfo>((r) => ({
        slot: r.slot,
        savedAt: r.savedAt,
        bytes: r.bytes?.length ?? 0,
        ...(r.thumb ? { thumb: r.thumb } : {}),
        ...(r.label ? { label: r.label } : {})
      }))
      .sort((a, b) => a.slot - b.slot);
  } catch (err) {
    console.warn("[State] listSlots failed:", err);
    return [];
  }
}

// ─── Auto-snapshot ────────────────────────────────────────────────────────
// Private resume-where-you-left-off state. Saved on tab hide / beforeunload
// and restored automatically the next time the same cart is loaded. Lives in
// the same IDB store as user slots (under a reserved negative slot number)
// so we get quota + cart-keying for free.

export async function saveAutoState(gb: GameBoy): Promise<boolean> {
  return saveStateTo(gb, AUTO_SLOT);
}

export async function loadAutoState(gb: GameBoy): Promise<boolean> {
  return loadStateFrom(gb, AUTO_SLOT);
}

export async function hasAutoState(cart: Cartridge): Promise<boolean> {
  return hasState(cart, AUTO_SLOT);
}

export async function clearAutoState(cart: Cartridge): Promise<void> {
  return clearSlot(cart, AUTO_SLOT);
}

/** Forget the stored blob, timestamp, and thumbnail for one slot. */
export async function clearSlot(cart: Cartridge, slot: number): Promise<void> {
  try {
    await idbDelete(STORE_SAVE_STATES, recordId(cart, slot));
  } catch {
    /* ignore */
  }
}

/** Set or clear the user-entered label for an occupied slot. Passing an
 *  empty string or null clears the label. Returns false if the slot is
 *  empty (nothing to attach the label to). Trims + caps length so a
 *  huge string doesn't bloat the record. */
export async function setSlotLabel(cart: Cartridge, slot: number, label: string | null): Promise<boolean> {
  try {
    const rec = await idbGet<StateRecord>(STORE_SAVE_STATES, recordId(cart, slot));
    if (!rec) return false;
    const trimmed = label?.trim().slice(0, 60);
    if (trimmed) rec.label = trimmed;
    else delete rec.label;
    await idbPut(STORE_SAVE_STATES, rec);
    return true;
  } catch {
    return false;
  }
}
