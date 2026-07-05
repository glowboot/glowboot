import type { CheatFormat } from "./codec.js";
import { isRamAddress } from "./codec.js";

/**
 * Runtime cheat engine for the SNES, mirroring the GB/NES managers. Two
 * hot-path entry points:
 *
 *   - `patchRomRead(addr, orig)` — called by the bus for every cart-ROM read
 *     with the normalised bus address ((bank & 0x7f) << 16 | offset).
 *     Returns the Game Genie replacement byte, else the original.
 *
 *   - `applyRamWrites(write)` — called once per frame. Re-writes each
 *     RAM-freeze value (WRAM / SRAM addresses) so an "infinite X" cheat
 *     sticks even when the game rewrites the address.
 *
 * The entry list is the source of truth; mutations rebuild the fast-path
 * maps so the common no-cheats case is a size check.
 */

export interface CheatEntry {
  id: string;
  name: string;
  code: string; // original user-typed string, for display
  format: CheatFormat;
  enabled: boolean;
  address: number;
  value: number;
}

export class CheatManager {
  private _entries: CheatEntry[] = [];
  private romPatches = new Map<number, number>();
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

  patchRomRead(addr: number, original: number): number {
    if (this.romPatches.size === 0) return original;
    const v = this.romPatches.get(addr);
    return v === undefined ? original : v;
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
      if (isRamAddress(e.address)) {
        this.ramWrites.set(e.address, e.value);
      } else {
        // normalise to the mirrored system-bank form the bus reads with
        this.romPatches.set((((e.address >> 16) & 0x7f) << 16) | (e.address & 0xffff), e.value);
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
