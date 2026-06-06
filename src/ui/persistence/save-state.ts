import { type GameBoy, UnsupportedSaveStateError } from "../../gb";
import { Gba, parseGbaHeader, UnsupportedGbaSaveStateError } from "../../gba";
import { errorToast } from "../hud/toast.js";
import { cartIdOf, cartIdOfGba } from "./cart-id.js";
import { idbDelete, idbGet, idbGetAllByIndex, idbPut, STORE_SAVE_STATES } from "./storage.js";

/**
 * Save-state persistence for the `save-states` IndexedDB store. Every
 * record is keyed on "<cartId>:<slot>" and carries the cart id as a
 * separate `cartId` field so the UI can enumerate all slots for the
 * active cart via a single indexed query.
 *
 * The binary format itself lives per-engine:
 *  - `src/gb/serialization/serialization.ts` (GB)
 *  - `src/gba/serialization/serialization.ts` (GBA)
 *
 * This module is engine-polymorphic: the GB cart-id derivation
 * (`<title>:<headerChecksum>:<romCrc32>`) and GBA cart-id
 * (`gba:<title>:<gameCode>:<hdrChk>:<romCrc32>`) live in cart-id.ts
 * and produce disjoint namespaces, so the shared IDB store can hold
 * states from both engines without collision.
 */

/** Engines this module knows how to snapshot. Both expose a compatible
 *  `saveState()` / `loadState()` shape on their respective classes;
 *  cart-id derivation routes through `engineCartId`. */
export type SaveStateEngine = GameBoy | Gba;

/** True when the given engine is a GBA instance. Exported so the
 *  save-state import/export layer can choose engine-specific file
 *  extensions (`.gbastate` vs `.gbstate`) at the user-visible
 *  download / file-picker boundary. */
export function isGbaEngine(engine: SaveStateEngine): engine is Gba {
  return engine instanceof Gba;
}

function isGba(engine: SaveStateEngine): engine is Gba {
  return isGbaEngine(engine);
}

/** Stable per-engine string used as the IDB key prefix. */
export function engineCartId(engine: SaveStateEngine): string {
  return isGba(engine) ? cartIdOfGba(engine) : cartIdOf(engine.cart);
}

/** Human-readable title for the engine's cart — used by the save-state
 *  export filename + the import-mismatch toast. GB reads the parsed
 *  `cart.title`; GBA parses the ROM header lazily because `Gba` doesn't
 *  surface a pre-parsed title field. */
export function engineCartTitle(engine: SaveStateEngine): string {
  return isGba(engine) ? parseGbaHeader(engine.mem.rom).title : engine.cart.title;
}

function recordId(engine: SaveStateEngine, slot: number): string {
  return `${engineCartId(engine)}:${slot}`;
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

export async function saveStateTo(engine: SaveStateEngine, slot = 0, thumb?: string): Promise<boolean> {
  try {
    const bytes = engine.saveState();
    const id = recordId(engine, slot);
    // Preserve any user-entered label across re-saves into the same slot —
    // overwriting the state bytes shouldn't wipe the "Before Ganon" tag.
    const existing = await idbGet<StateRecord>(STORE_SAVE_STATES, id);
    const rec: StateRecord = {
      id,
      cartId: engineCartId(engine),
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

export async function loadStateFrom(engine: SaveStateEngine, slot = 0): Promise<boolean> {
  try {
    const rec = await idbGet<StateRecord>(STORE_SAVE_STATES, recordId(engine, slot));
    if (!rec) return false;
    engine.loadState(rec.bytes);
    return true;
  } catch (err) {
    // Version-mismatch / migrator-missing failures get a user-readable
    // explanation; everything else falls through to a generic warning.
    // Both engines have their own UnsupportedXxxError class — both
    // expose a `.message` we can surface verbatim.
    if (err instanceof UnsupportedSaveStateError || err instanceof UnsupportedGbaSaveStateError) {
      errorToast(err.message);
    }
    console.warn("[State] load failed:", err);
    return false;
  }
}

export async function hasState(engine: SaveStateEngine, slot = 0): Promise<boolean> {
  try {
    const rec = await idbGet<StateRecord>(STORE_SAVE_STATES, recordId(engine, slot));
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

/** Enumerate every save slot that has data for `engine`'s cart. Empty
 *  slots are simply absent from the returned array. Async because the
 *  `save-states` store is in IndexedDB. Filters out the private
 *  auto-snapshot slot. */
export async function listSlots(engine: SaveStateEngine): Promise<SlotInfo[]> {
  try {
    const recs = await idbGetAllByIndex<StateRecord>(STORE_SAVE_STATES, "cartId", engineCartId(engine));
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

export async function saveAutoState(engine: SaveStateEngine): Promise<boolean> {
  return saveStateTo(engine, AUTO_SLOT);
}

export async function loadAutoState(engine: SaveStateEngine): Promise<boolean> {
  return loadStateFrom(engine, AUTO_SLOT);
}

export async function hasAutoState(engine: SaveStateEngine): Promise<boolean> {
  return hasState(engine, AUTO_SLOT);
}

export async function clearAutoState(engine: SaveStateEngine): Promise<void> {
  return clearSlot(engine, AUTO_SLOT);
}

/** Forget the stored blob, timestamp, and thumbnail for one slot. */
export async function clearSlot(engine: SaveStateEngine, slot: number): Promise<void> {
  try {
    await idbDelete(STORE_SAVE_STATES, recordId(engine, slot));
  } catch {
    /* ignore */
  }
}

/** Set or clear the user-entered label for an occupied slot. Passing an
 *  empty string or null clears the label. Returns false if the slot is
 *  empty (nothing to attach the label to). Trims + caps length so a
 *  huge string doesn't bloat the record. */
export async function setSlotLabel(engine: SaveStateEngine, slot: number, label: string | null): Promise<boolean> {
  try {
    const rec = await idbGet<StateRecord>(STORE_SAVE_STATES, recordId(engine, slot));
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
