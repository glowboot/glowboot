/**
 * Library backup / restore — full per-cart game data.
 *
 * Dumps every row from the four IndexedDB stores into a single JSON
 * document. Binary fields (`romBytes`, `ramBytes`, save-state `bytes`)
 * are base64-encoded inline; thumbnails are already `data:` URLs so
 * they pass through as strings. On import we pour each record back into
 * its original store with `idbPut`, preserving the exact shape the
 * reading modules expect.
 *
 * Design notes:
 *
 *  - **Merges, not replaces.** Import upserts — existing rows for the
 *    same cartId get overwritten; rows in the DB not present in the
 *    file are left alone. Safer default than a clobber restore.
 *  - **One big file.** A full library can be tens of megabytes (ROMs
 *    alone run 32 KB to 8 MB per cart). Splitting per cart would be
 *    nicer for sharing but bigger UX scope; keeping this simple for v1.
 *  - **Base64, not MessagePack / CBOR.** ~33% size inflation is
 *    acceptable for a backup file; avoiding a dependency is worth more.
 *  - **Reload after import.** The emulator has per-cart state hot in
 *    RAM (running GameBoy instance, cheats, play-time tracker). Rather
 *    than invalidate all of that in place, we reload the page so every
 *    init path re-reads fresh IndexedDB rows.
 */

import { saveBlobNative } from "../../save-blob.js";
import {
  idbGetAll,
  idbPut,
  openDb,
  STORE_CHEATS,
  STORE_PRINTOUTS,
  STORE_ROMS,
  STORE_SAVE_RAM,
  STORE_SAVE_STATES
} from "../storage.js";
import { b64ToBytes, bytesToB64 } from "./base64.js";

const TAG = "gameboy-emulator-library";

/** Bump when the bundle's shape changes. v2 added `printouts`. The
 *  importer still accepts v1 files — printouts are simply absent. */
const VERSION = 2;

/** Fields we know are binary and need base64 encoding in the JSON.
 *  `pixels` belongs to printout records (one byte per pixel, 0..3). */
const BINARY_FIELDS = new Set(["romBytes", "ramBytes", "bytes", "pixels"]);

interface LibraryBundle {
  $: string;
  version: number;
  exportedAt: string;
  roms: Record<string, unknown>[];
  saveRam: Record<string, unknown>[];
  saveStates: Record<string, unknown>[];
  cheats: Record<string, unknown>[];

  /** Added in v2. Optional in the type so v1 imports type-check without
   *  a cast — `isBundle` requires the array on v2 explicitly. */
  printouts?: Record<string, unknown>[];
}

/** Clone a row with known binary fields replaced by base64 strings. */
function recordToJson(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (BINARY_FIELDS.has(k) && v instanceof Uint8Array) out[k] = bytesToB64(v);
    else out[k] = v;
  }
  return out;
}

/** Reverse of `recordToJson` — decode b64 strings back to Uint8Array. */
function jsonToRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (BINARY_FIELDS.has(k) && typeof v === "string") out[k] = b64ToBytes(v);
    else out[k] = v;
  }
  return out;
}

// ─── Export ────────────────────────────────────────────────────────────────

/** Serialise every IDB store into a single JSON string. Async because it
 *  has to wait on IDB reads; the result is held fully in memory before
 *  download, which is fine for the sizes this app deals with. */
async function exportLibrary(): Promise<string> {
  await openDb();
  const [roms, saveRam, saveStates, cheats, printouts] = await Promise.all([
    idbGetAll<Record<string, unknown>>(STORE_ROMS),
    idbGetAll<Record<string, unknown>>(STORE_SAVE_RAM),
    idbGetAll<Record<string, unknown>>(STORE_SAVE_STATES),
    idbGetAll<Record<string, unknown>>(STORE_CHEATS),
    idbGetAll<Record<string, unknown>>(STORE_PRINTOUTS)
  ]);
  const bundle: LibraryBundle = {
    $: TAG,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    roms: roms.map(recordToJson),
    saveRam: saveRam.map(recordToJson),
    saveStates: saveStates.map(recordToJson),
    cheats: cheats.map(recordToJson),
    printouts: printouts.map(recordToJson)
  };
  // No pretty-print — backups can be big and indentation alone can inflate
  // a 20 MB file by 10-20%. Users import as a blob, not read by hand.
  return JSON.stringify(bundle);
}

/** Save the current library as a single JSON file, named with today's
 *  date so multiple snapshots coexist. On phones the blob routes
 *  through the Web Share API so the OS share sheet appears; on
 *  desktop a `<a download>` fires. */
export async function downloadLibrary(): Promise<void> {
  const json = await exportLibrary();
  const blob = new Blob([json], { type: "application/json" });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `gameboy-library-${stamp}.json`;
  const share = await saveBlobNative(blob, filename);
  if (share === "shared" || share === "cancelled") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Import ────────────────────────────────────────────────────────────────

export interface ImportResult {
  ok: boolean;
  reason?: string;
  counts?: { roms: number; saveRam: number; saveStates: number; cheats: number; printouts: number };
}

/** Parse + validate a previously-exported library bundle and upsert every
 *  row into its original IDB store. On schema / tag mismatch returns
 *  `{ ok: false, reason }` without touching the database. */
export async function importLibrary(json: string): Promise<ImportResult> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(json);
  } catch {
    return { ok: false, reason: "File isn't valid JSON" };
  }
  if (!isBundle(bundle)) return { ok: false, reason: "Not a Game Boy library backup" };

  const counts = { roms: 0, saveRam: 0, saveStates: 0, cheats: 0, printouts: 0 };
  try {
    for (const rec of bundle.roms) {
      await idbPut(STORE_ROMS, jsonToRecord(rec));
      counts.roms++;
    }
    for (const rec of bundle.saveRam) {
      await idbPut(STORE_SAVE_RAM, jsonToRecord(rec));
      counts.saveRam++;
    }
    for (const rec of bundle.saveStates) {
      await idbPut(STORE_SAVE_STATES, jsonToRecord(rec));
      counts.saveStates++;
    }
    for (const rec of bundle.cheats) {
      // Cheats don't carry any binary, but keep the same round-trip.
      await idbPut(STORE_CHEATS, jsonToRecord(rec));
      counts.cheats++;
    }
    // Printouts are v2+; v1 files won't carry them and the field is
    // simply absent. The base64-decoded `pixels` Uint8Array goes back
    // into IDB as native binary.
    for (const rec of bundle.printouts ?? []) {
      await idbPut(STORE_PRINTOUTS, jsonToRecord(rec));
      counts.printouts++;
    }
  } catch (err) {
    console.warn("[Library] import aborted:", err);
    return { ok: false, reason: "Write to IndexedDB failed", counts };
  }
  return { ok: true, counts };
}

function isBundle(x: unknown): x is LibraryBundle {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (
    o.$ !== TAG ||
    typeof o.version !== "number" ||
    !Array.isArray(o.roms) ||
    !Array.isArray(o.saveRam) ||
    !Array.isArray(o.saveStates) ||
    !Array.isArray(o.cheats)
  ) {
    return false;
  }
  // v2+ added printouts. If present at all, it must be an array — but
  // its absence is fine (v1 files, or v2 backups taken before the user
  // ever ran a printer-aware ROM).
  return o.printouts === undefined || Array.isArray(o.printouts);
}
