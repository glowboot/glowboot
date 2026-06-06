import type { MappedBus } from "../memory/mapped-bus.js";
import type { GbaCheatWidth } from "./codec.js";

/**
 * Runtime cheat engine for the GBA core. Holds the active cheat set
 * and exposes one hot-path entry point: `apply(bus)`, called once per
 * frame from `Gba.runFrame`, which writes each enabled code's value
 * into RAM. Per-frame writes are the GBA's analogue of the GB
 * Game Shark mode — the cart can update the targeted byte itself
 * between writes, so "infinite X" cheats stick on the first frame
 * after the game decrements the value.
 *
 * Only RAM-poke cheats are supported. ROM-patch (Game-Genie-style)
 * codes don't apply on the GBA: cart ROM is mapped read-only at
 * 0x08000000-0x0DFFFFFF and most games execute IWRAM-resident copies
 * of hot code, so a ROM patch would be invisible to the running game.
 *
 * Width handling: each cheat carries an 8/16/32 width; the manager
 * dispatches to the matching bus write so palette/VRAM/etc. byte-mode
 * regions still receive the wider transaction the game expects.
 */

export interface GbaCheatEntry {
  id: string;
  name: string;
  code: string; // canonical display form, e.g. "020003A4:01"
  enabled: boolean;
  address: number;
  value: number;
  width: GbaCheatWidth;
}

export class GbaCheatManager {
  private _entries: GbaCheatEntry[] = [];
  private active: GbaCheatEntry[] = [];

  get entries(): readonly GbaCheatEntry[] {
    return this._entries;
  }

  /** Replace the active set (on cart load or bulk restore). */
  setEntries(entries: readonly GbaCheatEntry[]): void {
    this._entries = entries.map((e) => ({ ...e }));
    this.rebuild();
  }

  add(entry: GbaCheatEntry): void {
    this._entries.push({ ...entry });
    this.rebuild();
  }

  remove(id: string): void {
    this._entries = this._entries.filter((e) => e.id !== id);
    this.rebuild();
  }

  setEnabled(id: string, enabled: boolean): void {
    const e = this._entries.find((x) => x.id === id);
    if (!e) return;
    e.enabled = enabled;
    this.rebuild();
  }

  clear(): void {
    this._entries = [];
    this.rebuild();
  }

  /** Hot path — called once per frame. Bails out fast on the empty set
   *  so an idle cart pays nothing. */
  apply(bus: MappedBus): void {
    if (this.active.length === 0) return;
    for (const e of this.active) {
      if (e.width === 8) bus.write8(e.address, e.value);
      else if (e.width === 16) bus.write16(e.address, e.value);
      else bus.write32(e.address, e.value);
    }
  }

  private rebuild(): void {
    this.active = this._entries.filter((e) => e.enabled);
  }
}

/** Generate a stable unique id for a new cheat entry. Mirrors the GB
 *  helper so the persistence layer can stay format-agnostic. */
export function newGbaCheatId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
