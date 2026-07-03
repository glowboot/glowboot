/**
 * Symbol-file loader / lookup.
 *
 * NES symbol files come in a few flavours; we accept a flat 16-bit form that
 * covers the common ones:
 *
 *   AAAA name            plain "address label" (ca65 / asm6 listings)
 *   $AAAA name
 *   $AAAA#name#comment   `.nl` name-list line ('#'-separated)
 *
 * AAAA is a CPU address in hex; name is the identifier. Blank lines, `;`
 * comments, and any line that doesn't match are ignored, so banner text and
 * section headers are tolerated. Unlike the Game Boy (RGBDS `BB:AAAA`) there is
 * no bank field — NES banking is mapper-specific and dynamic, so symbols are
 * keyed by their 16-bit CPU address only (which is correct for zero-page / RAM
 * and the fixed PRG bank that most labels of interest live in).
 *
 * Storage: module scope (one active table at a time), matching the breakpoint /
 * call-stack modules. Cleared on ROM load.
 */

export interface SymbolEntry {
  addr: number;
  name: string;
}

const byAddr = new Map<number, SymbolEntry>();
const byName = new Map<string, SymbolEntry>();
let loadedSourceLabel = "";

// $?AAAA <sep> name — sep is whitespace, '#' (name-list) or ':'.
const LINE_RE = /^\$?([0-9a-f]{1,4})[\s#:]+([A-Za-z_.][\w.]*)/i;

/**
 * Parse a symbol file and replace the current table. Returns the number of
 * entries loaded (not counting duplicates / invalid lines). Duplicates: last
 * wins for the by-address map; first wins for the by-name map.
 */
export function loadSymbols(text: string, sourceLabel: string): number {
  byAddr.clear();
  byName.clear();
  loadedSourceLabel = sourceLabel;
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, "").trim();
    if (line === "" || line.startsWith("[")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const addr = parseInt(m[1]!, 16) & 0xffff;
    const name = m[2]!;
    const entry: SymbolEntry = { addr, name };
    byAddr.set(addr, entry);
    if (!byName.has(name)) byName.set(name, entry);
    count++;
  }
  return count;
}

export function clearSymbols(): void {
  byAddr.clear();
  byName.clear();
  loadedSourceLabel = "";
}

export function hasSymbols(): boolean {
  return byAddr.size > 0;
}

export function symbolCount(): number {
  return byAddr.size;
}

export function sourceLabel(): string {
  return loadedSourceLabel;
}

/** Resolve an address to a symbol name, or null if unknown. */
export function symbolFor(addr: number): string | null {
  if (byAddr.size === 0) return null;
  return byAddr.get(addr & 0xffff)?.name ?? null;
}

/** Reverse lookup — identifier → entry. Returns null if unknown. */
export function addressFor(name: string): SymbolEntry | null {
  return byName.get(name) ?? null;
}

/** All known symbols, sorted by address. Used by the pane's list. */
export function allSymbols(): SymbolEntry[] {
  return [...byAddr.values()].sort((a, b) => a.addr - b.addr);
}
