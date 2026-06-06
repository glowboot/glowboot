/**
 * GBA symbol-file loader / lookup. Parallel to `src/gb/debug/symbols.ts`.
 *
 * Accepted line format (one symbol per line):
 *
 *   [0x]AAAAAAAA[:]  NAME   ; optional comment
 *
 * 1-8 hex digits for the address, optional `0x` / `$` prefix, optional
 * trailing colon, then an identifier. Lines that don't match are
 * silently skipped — practical for pasting in a `nm` / `.map`
 * excerpt that has banner lines, section headers, or size columns.
 *
 * GBA has no ROM banking (the cartridge is mapped linearly from
 * 0x08000000), so the bank dimension that complicates GB lookups is
 * absent — one `addr → name` map covers everything.
 *
 * Lookup model:
 *   - Map keyed by absolute 32-bit address (`addr >>> 0`).
 *   - `gbaSymbolFor(addr)` exact-match only.
 *   - `gbaAddressFor(name)` exact-match, case-sensitive.
 *
 * Storage: kept in module scope (one active table at a time), mirrors
 * the breakpoint / call-stack modules. Cleared on cart load.
 */

export interface GbaSymbolEntry {
  addr: number;
  name: string;
}

const byAddr = new Map<number, GbaSymbolEntry>();
const byName = new Map<string, GbaSymbolEntry>();
let loadedSourceLabel = "";

// Address: 1-8 hex chars with optional `0x` / `$` prefix and optional
// trailing colon. Name: standard C identifier (allow `.` so labels
// like `__udivsi3` from libgcc come through).
const LINE_RE = /^(?:0x|\$)?([0-9a-f]{1,8}):?\s+([A-Za-z_.][\w.]*)/i;

/**
 * Parse a text blob and replace the current symbol table. Returns the
 * number of entries actually loaded (duplicates are merged, last-wins
 * for the by-address map and first-wins for the by-name map).
 */
export function loadGbaSymbols(text: string, sourceLabel: string): number {
  byAddr.clear();
  byName.clear();
  loadedSourceLabel = sourceLabel;
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, "").trim();
    if (line === "" || line.startsWith("[")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const addr = parseInt(m[1]!, 16) >>> 0;
    if (!Number.isFinite(addr)) continue;
    const name = m[2]!;
    const entry: GbaSymbolEntry = { addr, name };
    byAddr.set(addr, entry);
    if (!byName.has(name)) byName.set(name, entry);
    count++;
  }
  return count;
}

export function clearGbaSymbols(): void {
  byAddr.clear();
  byName.clear();
  loadedSourceLabel = "";
}

export function hasGbaSymbols(): boolean {
  return byAddr.size > 0;
}

export function gbaSymbolCount(): number {
  return byAddr.size;
}

export function gbaSymbolSourceLabel(): string {
  return loadedSourceLabel;
}

/** Resolve an address to its symbol name, or null if unknown. */
export function gbaSymbolFor(addr: number): string | null {
  if (byAddr.size === 0) return null;
  return byAddr.get(addr >>> 0)?.name ?? null;
}

/** Reverse lookup — identifier → entry, or null. */
export function gbaAddressFor(name: string): GbaSymbolEntry | null {
  return byName.get(name) ?? null;
}

/** All known symbols, sorted by address. Used by the pane's list. */
export function allGbaSymbols(): GbaSymbolEntry[] {
  return [...byAddr.values()].sort((a, b) => a.addr - b.addr);
}
