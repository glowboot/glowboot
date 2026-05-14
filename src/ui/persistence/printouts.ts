import type { Cartridge, PrintedPage } from "../../gb";
import { cartIdOf } from "./cart-id.js";
import { idbDelete, idbGetAll, idbPut, openDb, STORE_PRINTOUTS } from "./storage.js";

/**
 * Persisted printer history — global queue of every captured Game Boy
 * Printer page across every cart, newest first. Survives page reloads
 * (was previously held in a module-level array that disappeared the
 * moment the user refreshed). Records are keyed by `savedAt:counter`
 * so the id is sortable by time and unique even for two prints in the
 * same millisecond.
 *
 * `cartId` is captured on each record so future tooling can group or
 * filter by source cart, but the popover renders them all together as
 * one queue (the user's mental model is "the printer's tray", not
 * "this cart's tray"). The `cartId` index on the IDB store is kept
 * around for that future feature.
 *
 * Pixel data is stored as `Uint8Array` (one byte per pixel, value
 * 0..3) — typical 160×144 page is ~23 KB, well within IDB's quota.
 * Encoding to PNG up-front would shrink it but each render needs an
 * `<canvas>` anyway, so the raw bytes are the cheaper format to
 * round-trip.
 */

export interface StoredPrintout {
  id: string;
  cartId: string;
  savedAt: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

let counter = 0;

/** Append a captured page to the store, tagged with the active cart's
 *  id. Returns the stored record so callers can update their in-memory
 *  list without re-reading from IDB. */
export async function persistPrintout(cart: Cartridge, page: PrintedPage): Promise<StoredPrintout> {
  const savedAt = Date.now();
  // Counter disambiguates two prints emitted in the same millisecond
  // (rare in practice — INIT/PRINT round-trips are ~80 ms — but the
  // tick resolution on some browsers / fake timers can collapse to
  // the same `Date.now()`). Padded so lexicographic sort matches
  // chronological order.
  const id = `${savedAt.toString().padStart(13, "0")}:${(counter++).toString().padStart(4, "0")}`;
  const record: StoredPrintout = {
    id,
    cartId: cartIdOf(cart),
    savedAt,
    width: page.width,
    height: page.height,
    // Copy so the caller can re-use its buffer without aliasing into
    // the persisted record.
    pixels: new Uint8Array(page.pixels)
  };
  await idbPut(STORE_PRINTOUTS, record);
  return record;
}

/** List every printout, newest-first, regardless of which cart
 *  produced it. The printer popover renders this as one shared
 *  queue — same conceptual model as a real thermal printer's tray. */
export async function listPrintouts(): Promise<StoredPrintout[]> {
  const records = await idbGetAll<StoredPrintout>(STORE_PRINTOUTS);
  records.sort((a, b) => b.savedAt - a.savedAt);
  return records;
}

/** Remove a single printout by its store id. */
export async function deletePrintout(id: string): Promise<void> {
  await idbDelete(STORE_PRINTOUTS, id);
}

/** Wipe the entire printer history. Used by the popover's "Clear
 *  all" button. */
export async function clearAllPrintouts(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PRINTOUTS, "readwrite");
    tx.objectStore(STORE_PRINTOUTS).clear();
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
    tx.onabort = (): void => reject(tx.error);
  });
}
