import type { MMU } from "../memory/mmu.js";
import type { CheatFormat } from "./codec.js";

/**
 * Runtime cheat engine. Holds the set of cheats active for the current
 * cartridge and exposes two hot-path entry points:
 *
 *   - `patchRomRead(addr, orig)` — called by MMU for every 0x0000..0x7FFF
 *     read. Returns the replacement byte for Game Genie codes (subject to
 *     the compare-byte check), otherwise the original value unchanged.
 *
 *   - `applyRamWrites(mmu)` — called once per frame by GameBoy. Writes each
 *     active Game Shark code's value into RAM, freezing the targeted byte
 *     so "infinite X" codes stick even when the game rewrites the address.
 *
 * The entry list is the source of truth; mutations rebuild the fast-path
 * maps so the hot paths stay O(1) lookups.
 */

export interface CheatEntry {
  id: string;
  name: string;
  code: string; // original user-typed string, for display
  format: CheatFormat;
  enabled: boolean;
  address: number;
  value: number;
  compare?: number; // Game Genie only
}

export class CheatManager {
  private _entries: CheatEntry[] = [];
  private romPatches = new Map<number, { value: number; compare?: number }>();
  private ramWrites = new Map<number, number>();

  get entries(): readonly CheatEntry[] {
    return this._entries;
  }

  /** Replace the active set (on cart load or bulk restore). */
  setEntries(entries: readonly CheatEntry[]): void {
    this._entries = entries.map((e) => ({ ...e }));
    this.rebuildMaps();
  }

  add(entry: CheatEntry): void {
    this._entries.push({ ...entry });
    this.rebuildMaps();
  }

  remove(id: string): void {
    this._entries = this._entries.filter((e) => e.id !== id);
    this.rebuildMaps();
  }

  setEnabled(id: string, enabled: boolean): void {
    const e = this._entries.find((x) => x.id === id);
    if (!e) return;
    e.enabled = enabled;
    this.rebuildMaps();
  }

  clear(): void {
    this._entries = [];
    this.rebuildMaps();
  }

  // ─── Hot path ──────────────────────────────────────────────────────────
  // patchRomRead is called from MMU.readByte for every ROM read, so early-
  // exit the common no-patches case without a Map lookup.

  patchRomRead(addr: number, original: number): number {
    if (this.romPatches.size === 0) return original;
    const p = this.romPatches.get(addr);
    if (!p) return original;
    if (p.compare !== undefined && p.compare !== original) return original;
    return p.value;
  }

  applyRamWrites(mmu: MMU): void {
    if (this.ramWrites.size === 0) return;
    for (const [addr, value] of this.ramWrites) {
      mmu.writeByte(addr, value);
    }
  }

  private rebuildMaps(): void {
    this.romPatches.clear();
    this.ramWrites.clear();
    for (const e of this._entries) {
      if (!e.enabled) continue;
      if (e.format === "game-genie") {
        // Game Genie is documented to only patch 0x0000..0x7FFF; the codec
        // already enforces that, so trust the address here.
        this.romPatches.set(
          e.address,
          e.compare !== undefined ? { value: e.value, compare: e.compare } : { value: e.value }
        );
      } else {
        // Game Shark writes to RAM; never let one trigger an MBC bank
        // switch by writing into ROM space.
        if (e.address < 0x8000) continue;
        this.ramWrites.set(e.address, e.value);
      }
    }
  }
}

/** Generate a stable unique id for a new cheat entry. Falls back to a
 *  timestamp+random suffix if crypto.randomUUID is unavailable. */
export function newCheatId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
