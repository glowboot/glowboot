/**
 * Single-slot save-state export / import. The file format mirrors the
 * `LibraryBundle` style used by library.ts: a thin JSON envelope around
 * the binary state bytes (base64-encoded) plus the per-slot metadata
 * (timestamp, label, thumbnail). One `.gbstate` file = one slot, so
 * users can share a specific moment (speedrun split, boss setup,
 * glitch fixture) without bundling the whole library.
 *
 * Import refuses to write into the current cart's slot unless the
 * file's `cartId` matches — each cart has its own save-state format
 * imprint and cross-loading would corrupt the engine. The check uses
 * the same CRC-hashed id as the Library, so a patched ROM and its
 * vanilla twin are distinct carts even with identical titles.
 *
 * Engine-polymorphic: GB and GBA carts share the same envelope format
 * because the only engine-specific bit is the opaque state bytes, and
 * the cart-id namespaces are disjoint (`gba:` prefix on GBA ids
 * prevents cross-engine collisions).
 */

import { saveBlobNative } from "../../save-blob.js";
import { engineCartId, engineCartTitle, isGbaEngine, type SaveStateEngine } from "../save-state.js";
import { idbGet, idbPut, STORE_SAVE_STATES } from "../storage.js";
import { b64ToBytes, bytesToB64 } from "./base64.js";

const TAG = "gameboy-emulator-state";
const VERSION = 1;

interface StateRecord {
  id: string;
  cartId: string;
  slot: number;
  bytes: Uint8Array;
  savedAt: number;
  thumb?: string;
  label?: string;
}

interface StateBundle {
  $: string;
  version: number;
  cartId: string;
  cartTitle: string; // human-readable label shown in import prompts / errors
  slot: number;
  savedAt: number;
  label?: string;
  thumb?: string;
  bytes: string; // base64 of the serialised engine state
}

// ─── Export ────────────────────────────────────────────────────────────────

/** Serialise the given slot into a standalone bundle. Returns null if
 *  the slot is empty so callers can no-op without a try/catch. */
async function exportSlot(engine: SaveStateEngine, slot: number): Promise<string | null> {
  const cartId = engineCartId(engine);
  const id = `${cartId}:${slot}`;
  const rec = await idbGet<StateRecord>(STORE_SAVE_STATES, id);
  if (!rec || !rec.bytes) return null;
  const bundle: StateBundle = {
    $: TAG,
    version: VERSION,
    cartId: rec.cartId,
    cartTitle: engineCartTitle(engine),
    slot: rec.slot,
    savedAt: rec.savedAt,
    bytes: bytesToB64(rec.bytes),
    ...(rec.label !== undefined ? { label: rec.label } : {}),
    ...(rec.thumb !== undefined ? { thumb: rec.thumb } : {})
  };
  return JSON.stringify(bundle);
}

/** Save a single slot to a `.gbstate` file. Filename baked to match the
 *  human-readable cart title + slot number so a user who dumps all ten
 *  slots ends up with a readable filename set.
 *
 *  On phones the blob routes through the Web Share API so the OS share
 *  sheet (Photos / Files / AirDrop / etc.) appears — iOS Safari ignores
 *  `<a download>`, which would otherwise silently swallow the file.
 *  Desktop falls back to the classic invisible-anchor download. */
export async function downloadSlot(engine: SaveStateEngine, slot: number): Promise<boolean> {
  const json = await exportSlot(engine, slot);
  if (!json) return false;
  const title = engineCartTitle(engine);
  const safeTitle = title.replace(/[^A-Za-z0-9_.-]/g, "_").trim() || "game";
  const blob = new Blob([json], { type: "application/json" });
  // The envelope itself is engine-polymorphic (cartId carries the
  // `gba:` prefix), but a per-engine file extension makes it obvious
  // at-a-glance which engine an exported state belongs to and keeps
  // the OS file-association heuristics tidy. Both extensions parse
  // identically on import — the cart-id check in the bundle decides
  // whether the file matches the currently-loaded cart.
  const ext = isGbaEngine(engine) ? "gbastate" : "gbstate";
  const filename = `${safeTitle}-slot${slot}.${ext}`;
  const share = await saveBlobNative(blob, filename);
  if (share === "shared") return true;
  if (share === "cancelled") return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// ─── Import ────────────────────────────────────────────────────────────────

export interface ImportResult {
  ok: boolean;
  reason?: string;
  slot?: number;

  /** cartTitle from the bundle — useful for a toast message on mismatch. */
  cartTitle?: string;
}

/** Parse a `.gbstate` JSON payload and, if the cartId matches the
 *  currently-loaded cart, upsert the record into IDB under the file's
 *  slot. Mismatched cartId is rejected rather than silently written —
 *  cross-loading a different cart's state would corrupt the engine. */
export async function importStateFile(engine: SaveStateEngine, json: string): Promise<ImportResult> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(json);
  } catch {
    return { ok: false, reason: "File isn't valid JSON" };
  }
  if (!isBundle(bundle)) return { ok: false, reason: "Not a Game Boy save-state file" };

  const currentId = engineCartId(engine);
  if (bundle.cartId !== currentId) {
    return {
      ok: false,
      reason: `State belongs to "${bundle.cartTitle}" — load that ROM first`,
      cartTitle: bundle.cartTitle
    };
  }
  if (bundle.slot < 0) {
    return { ok: false, reason: "Auto-snapshot slots can't be imported" };
  }

  const rec: StateRecord = {
    id: `${currentId}:${bundle.slot}`,
    cartId: currentId,
    slot: bundle.slot,
    bytes: b64ToBytes(bundle.bytes),
    savedAt: bundle.savedAt,
    ...(bundle.label !== undefined ? { label: bundle.label } : {}),
    ...(bundle.thumb !== undefined ? { thumb: bundle.thumb } : {})
  };
  try {
    await idbPut(STORE_SAVE_STATES, rec);
  } catch (err) {
    console.warn("[State IO] write failed:", err);
    return { ok: false, reason: "Write to IndexedDB failed" };
  }
  return { ok: true, slot: bundle.slot, cartTitle: bundle.cartTitle };
}

function isBundle(x: unknown): x is StateBundle {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.$ === TAG &&
    typeof o.version === "number" &&
    typeof o.cartId === "string" &&
    typeof o.cartTitle === "string" &&
    typeof o.slot === "number" &&
    typeof o.savedAt === "number" &&
    typeof o.bytes === "string"
  );
}
