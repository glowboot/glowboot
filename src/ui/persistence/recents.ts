import type { Cartridge } from "../../gb";
import { cartIdOf } from "./cart-id.js";
import { idbDelete, idbGet, idbGetAll, idbPut, openDb, STORE_ROMS } from "./storage.js";

/**
 * Recent-ROMs list, backed by the shared IndexedDB instance. ROM bytes
 * can run several MB so they can't live in localStorage; the shared
 * `roms` object store is keyed by a stable per-cart id (title + global
 * checksum).
 *
 * Kept deliberately small — we trim to `MAX_ENTRIES` on every insert
 * and silently swallow I/O errors (if the DB is misbehaving, the user
 * still has the ROM in memory via the file picker).
 */

const MAX_ENTRIES = 50;

export interface RecentEntry {
  id: string;
  title: string;
  filename: string;
  size: number;
  lastPlayedAt: number;
  totalPlayMs?: number; // cumulative wall-clock time the emulator ran this cart
  thumbnail?: string; // PNG data URL captured a few seconds into play
  romBytes?: Uint8Array; // omitted by list() — only fetched via get()
}

/** Re-export of the shared cart-id helper so the three external callers
 *  (rom-loader, cart-info popover) can reach it as `Recents.idFor(cart)`
 *  without a second import line. */
export const idFor = cartIdOf;

/** Record `cart` + its bytes as the most-recently played ROM. Trims the
 *  store to at most MAX_ENTRIES newest entries after insert.
 *
 *  Cumulative per-cart stats (`totalPlayMs`, `thumbnail`) are preserved
 *  across calls — `idbPut` overwrites the full record, so without this
 *  merge the play-time counter would reset to zero every time a ROM is
 *  re-loaded (either on first launch this session or when bumping the
 *  library timestamp after picking a card). */
export async function remember(cart: Cartridge, romBytes: Uint8Array, filename: string): Promise<void> {
  try {
    const id = idFor(cart);
    const existing = await idbGet<RecentEntry>(STORE_ROMS, id);
    const entry: RecentEntry = {
      id,
      title: cart.title || filename.replace(/\.[^.]+$/, ""),
      filename,
      size: romBytes.byteLength,
      lastPlayedAt: Date.now(),
      romBytes,
      ...(existing?.totalPlayMs !== undefined ? { totalPlayMs: existing.totalPlayMs } : {}),
      ...(existing?.thumbnail !== undefined ? { thumbnail: existing.thumbnail } : {})
    };
    await idbPut(STORE_ROMS, entry);
    // Trim: drop anything past the N most-recently-played.
    const all = await listAllSorted();
    if (all.length > MAX_ENTRIES) {
      const stale = all.slice(MAX_ENTRIES);
      for (const e of stale) await idbDelete(STORE_ROMS, e.id);
    }
  } catch (err) {
    console.warn("[Recents] remember failed:", err);
  }
}

/** Most-recent-first list without the (potentially large) ROM payload.
 *  Use `get(id)` to fetch the actual bytes when launching one. */
export async function list(): Promise<RecentEntry[]> {
  try {
    const all = await listAllSorted();
    return all.slice(0, MAX_ENTRIES).map(({ id, title, filename, size, lastPlayedAt, thumbnail, totalPlayMs }) => ({
      id,
      title,
      filename,
      size,
      lastPlayedAt,
      thumbnail,
      totalPlayMs
    }));
  } catch (err) {
    console.warn("[Recents] list failed:", err);
    return [];
  }
}

/** Add wall-clock milliseconds to an entry's cumulative play time.
 *  No-op if the entry no longer exists or `ms` is not positive. */
export async function addPlayTime(id: string, ms: number): Promise<void> {
  if (!(ms > 0)) return;
  try {
    const rec = await idbGet<RecentEntry>(STORE_ROMS, id);
    if (!rec) return;
    rec.totalPlayMs = (rec.totalPlayMs ?? 0) + ms;
    await idbPut(STORE_ROMS, rec);
  } catch (err) {
    console.warn("[Recents] addPlayTime failed:", err);
  }
}

/** Attach (or refresh) a captured thumbnail for an entry without touching
 *  any of its other fields. No-op if the entry has gone missing. */
export async function setThumbnail(id: string, thumbnail: string): Promise<void> {
  try {
    const rec = await idbGet<RecentEntry>(STORE_ROMS, id);
    if (!rec) return;
    rec.thumbnail = thumbnail;
    await idbPut(STORE_ROMS, rec);
  } catch (err) {
    console.warn("[Recents] setThumbnail failed:", err);
  }
}

/** Fetch the raw ROM bytes for a previously-remembered entry. */
export async function get(id: string): Promise<Uint8Array | null> {
  try {
    const rec = await idbGet<RecentEntry>(STORE_ROMS, id);
    return rec?.romBytes ?? null;
  } catch (err) {
    console.warn("[Recents] get failed:", err);
    return null;
  }
}

/** Drop a single entry. */
export async function forget(id: string): Promise<void> {
  try {
    await idbDelete(STORE_ROMS, id);
  } catch (err) {
    console.warn("[Recents] forget failed:", err);
  }
}

async function listAllSorted(): Promise<RecentEntry[]> {
  await openDb(); // ensure the DB (and migration) has been triggered
  const all = await idbGetAll<RecentEntry>(STORE_ROMS);
  return all.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}
