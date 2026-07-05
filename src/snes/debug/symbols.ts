/**
 * SNES symbol-file loader / lookup. Parallel to
 * `src/gba/debug/symbols.ts`, adapted to the 65C816's 24-bit
 * bank:offset addresses.
 *
 * Accepted line format (one symbol per line):
 *
 *   [0x|$][BB:]AAAA[:]  NAME   ; optional comment
 *
 * Either a `BB:AAAA` bank:offset pair (the common assembler .sym
 * convention) or a flat 1-6 hex-digit address, optional `0x` / `$`
 * prefix, optional trailing colon, then an identifier. Lines that
 * don't match are silently skipped — practical for pasting a build-log
 * or map-file excerpt that has banner lines or size columns.
 *
 * Lookup model:
 *   - Map keyed by absolute 24-bit address (`addr & 0xffffff`).
 *   - `snesSymbolFor(addr)` exact-match only.
 *   - `snesAddressFor(name)` exact-match, case-sensitive.
 *
 * Storage: kept in module scope (one active table at a time), mirrors
 * the breakpoint / call-stack modules. Cleared on cart load.
 */

export interface SnesSymbolEntry {
  addr: number;
  name: string;
}

const byAddr = new Map<number, SnesSymbolEntry>();
const byName = new Map<string, SnesSymbolEntry>();
let loadedSourceLabel = "";

// Address: optional 2-hex-digit bank + colon, then 1-6 hex chars, with
// optional `0x` / `$` prefix and optional trailing colon. Name:
// standard identifier (allow `.` so local labels come through).
const LINE_RE = /^(?:0x|\$)?(?:([0-9a-f]{1,2}):)?([0-9a-f]{1,6}):?\s+([A-Za-z_.][\w.]*)/i;

/**
 * Parse a text blob and replace the current symbol table. Returns the
 * number of entries actually loaded (duplicates are merged, last-wins
 * for the by-address map and first-wins for the by-name map).
 */
export function loadSnesSymbols(text: string, sourceLabel: string): number {
  byAddr.clear();
  byName.clear();
  loadedSourceLabel = sourceLabel;
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, "").trim();
    if (line === "" || line.startsWith("[")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const bank = m[1] !== undefined ? parseInt(m[1], 16) << 16 : 0;
    const addr = (bank | parseInt(m[2]!, 16)) & 0xffffff;
    if (!Number.isFinite(addr)) continue;
    const name = m[3]!;
    const entry: SnesSymbolEntry = { addr, name };
    byAddr.set(addr, entry);
    if (!byName.has(name)) byName.set(name, entry);
    count++;
  }
  return count;
}

export function clearSnesSymbols(): void {
  byAddr.clear();
  byName.clear();
  loadedSourceLabel = "";
}

export function hasSnesSymbols(): boolean {
  return byAddr.size > 0;
}

export function snesSymbolCount(): number {
  return byAddr.size;
}

export function snesSymbolSourceLabel(): string {
  return loadedSourceLabel;
}

/** Resolve an address to its symbol name, or null if unknown. */
export function snesSymbolFor(addr: number): string | null {
  if (byAddr.size === 0) return null;
  return byAddr.get(addr & 0xffffff)?.name ?? null;
}

/** Reverse lookup — identifier → entry, or null. */
export function snesAddressFor(name: string): SnesSymbolEntry | null {
  return byName.get(name) ?? null;
}

/** All known symbols, sorted by address. Used by the pane's list. */
export function allSnesSymbols(): SnesSymbolEntry[] {
  return [...byAddr.values()].sort((a, b) => a.addr - b.addr);
}
