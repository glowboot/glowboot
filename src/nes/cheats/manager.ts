import type { CheatFormat } from "./codec.js";

/**
 * Runtime cheat engine for the NES. Holds the cheats active for the current
 * cartridge and exposes two hot-path entry points, mirroring the GB engine:
 *
 *   - `patchRomRead(addr, orig)` — called by the console for every PRG read at
 *     $8000-$FFFF. Returns the Game Genie replacement byte (subject to the
 *     optional compare check, which lets a code target one bank of a multi-bank
 *     game), otherwise the original value unchanged.
 *
 *   - `applyRamWrites(write)` — called once per frame. Re-writes each RAM-cheat
 *     value so an "infinite X" freeze sticks even when the game rewrites the
 *     address. Targets internal RAM ($0000-$07FF) and cart PRG-RAM
 *     ($6000-$7FFF).
 *
 * The entry list is the source of truth; mutations rebuild the fast-path maps
 * so the hot paths stay O(1) and the common no-cheats case is a size check.
 */

export interface CheatEntry {
  id: string;
  name: string;
  code: string; // original user-typed string, for display
  format: CheatFormat;
  enabled: boolean;
  address: number;
  value: number;
  compare?: number;
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
  // patchRomRead is called for every PRG read, so early-exit the common
  // no-patches case without a Map lookup.

  patchRomRead(addr: number, original: number): number {
    if (this.romPatches.size === 0) return original;
    const p = this.romPatches.get(addr);
    if (!p) return original;
    if (p.compare !== undefined && p.compare !== original) return original;
    return p.value;
  }

  applyRamWrites(write: (addr: number, value: number) => void): void {
    if (this.ramWrites.size === 0) return;
    for (const [addr, value] of this.ramWrites) write(addr, value);
  }

  private rebuildMaps(): void {
    this.romPatches.clear();
    this.ramWrites.clear();
    for (const e of this._entries) {
      if (!e.enabled) continue;
      // Route by target: PRG space ($8000+) is a Game Genie ROM patch (compare
      // honoured); anything lower is a RAM freeze.
      if (e.address >= 0x8000) {
        this.romPatches.set(
          e.address,
          e.compare !== undefined ? { value: e.value, compare: e.compare } : { value: e.value }
        );
      } else {
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
