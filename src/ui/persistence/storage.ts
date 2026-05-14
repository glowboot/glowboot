/**
 * Shared IndexedDB layer.
 *
 * One database, six object stores:
 *   - `roms`            — { id, title, filename, size, lastPlayedAt, romBytes }
 *                         populated by `recents.ts`.
 *   - `save-ram`        — { id, ramBytes, rtc? }
 *                         battery-backed RAM + optional MBC3 RTC sidecar JSON.
 *   - `save-states`     — { id: "<cartId>:<slot>", cartId, slot, bytes,
 *                           savedAt, thumb? }
 *                         one record per (cart, slot) — `cartId` indexed for
 *                         fast slot enumeration per cart.
 *   - `cheats`          — { cartId, entries: CheatEntry[] }
 *                         one record per cart, holds the user's Game Genie /
 *                         Game Shark codes for that cart.
 *   - `cart-overrides`  — per-cart pinned settings (palette, render mode,
 *                         CGB colour correction, …) applied on cart load.
 *   - `printouts`       — Game Boy Printer page archive, one record per
 *                         printed page so the user can re-open them later.
 *
 * Only tiny user preferences (`gb-theme`, `gb-palette`, `gb-crt`,
 * `gb-volume`, `gb-mutes`) remain in localStorage — they need
 * synchronous access on first paint and are < 100 bytes total.
 */

const DB_NAME = "gameboy-emulator";
const DB_VERSION = 5;

export const STORE_ROMS = "roms";
export const STORE_SAVE_RAM = "save-ram";
export const STORE_SAVE_STATES = "save-states";
export const STORE_CHEATS = "cheats";
export const STORE_CART_OVERRIDES = "cart-overrides";
export const STORE_PRINTOUTS = "printouts";

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Lazily open (or upgrade) the shared database. Safe to call repeatedly —
 * subsequent calls return the cached handle. Failure clears the cached
 * promise so the next call can retry from scratch.
 */
export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ROMS)) {
        const s = db.createObjectStore(STORE_ROMS, { keyPath: "id" });
        s.createIndex("lastPlayedAt", "lastPlayedAt");
      }
      if (!db.objectStoreNames.contains(STORE_SAVE_RAM)) {
        db.createObjectStore(STORE_SAVE_RAM, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SAVE_STATES)) {
        const s = db.createObjectStore(STORE_SAVE_STATES, { keyPath: "id" });
        s.createIndex("cartId", "cartId");
      }
      if (!db.objectStoreNames.contains(STORE_CHEATS)) {
        db.createObjectStore(STORE_CHEATS, { keyPath: "cartId" });
      }
      if (!db.objectStoreNames.contains(STORE_CART_OVERRIDES)) {
        db.createObjectStore(STORE_CART_OVERRIDES, { keyPath: "cartId" });
      }
      if (!db.objectStoreNames.contains(STORE_PRINTOUTS)) {
        // One record per captured page; index on cartId so the printer
        // popover can fetch only the current cart's history without
        // scanning the whole store.
        const s = db.createObjectStore(STORE_PRINTOUTS, { keyPath: "id" });
        s.createIndex("cartId", "cartId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  dbPromise = p;
  return p;
}

// ── Generic per-store helpers ───────────────────────────────────────────────

export async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(storeName: string, value: object): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Fetch every record whose indexed value matches. Used by the
 *  save-states store via the `cartId` index to enumerate one cart's
 *  slots cheaply. */
export async function idbGetAllByIndex<T>(storeName: string, indexName: string, value: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  return await new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const idx = tx.objectStore(storeName).index(indexName);
    const req = idx.getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** Return all records in a store. Used by `recents.ts` to pull the top-N
 *  most-recently-played ROMs. */
export async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  return await new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}
