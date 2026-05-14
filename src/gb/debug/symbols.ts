/**
 * Symbol-file loader / lookup.
 *
 * Parses the RGBDS `.sym` format (also produced by WLA-DX):
 *
 *   BB:AAAA NAME        ; optional comment
 *
 * BB = bank in hex, AAAA = address in hex, NAME = identifier. Blank
 * lines and `;`-comments are ignored. Some tools prefix the file with a
 * `; ...` banner or a `[symbols]` section header; those are tolerated
 * because the regex rejects them and we just skip non-matching lines.
 *
 * Lookup model:
 *   - Map keyed by `(bank << 16) | addr` so the same address in
 *     different banks can have different names.
 *   - `symbolFor(addr, bank)` prefers the exact bank match; if none,
 *     falls back to bank-0 for bank-0 addresses (0x0000–0x3FFF) and
 *     bank-agnostic for non-ROM addresses (>= 0x8000) where tools
 *     typically record bank=0.
 *   - `addressFor(name)` does exact-match only — case-sensitive because
 *     RGBDS identifiers are.
 *
 * Storage: kept in module scope (one active symbol table at a time),
 * matching the breakpoint/call-stack modules. Cleared on ROM load.
 */

export interface SymbolEntry {
  bank: number;
  addr: number;
  name: string;
}

const byKey = new Map<number, SymbolEntry>();
const byName = new Map<string, SymbolEntry>();
let loadedSourceLabel = "";

const LINE_RE = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})\s+([A-Za-z_.][\w.]*)/i;

function makeKey(bank: number, addr: number): number {
  return ((bank & 0xffff) << 16) | (addr & 0xffff);
}

/**
 * Parse a `.sym` file and replace the current symbol table. Returns the
 * number of entries actually loaded (not counting duplicates / invalid
 * lines). Duplicates: last wins for the by-key map; first wins for the
 * by-name map (so the "primary" address of a name is the first one the
 * assembler emitted — usually the one you want).
 */
export function loadSymbols(text: string, sourceLabel: string): number {
  byKey.clear();
  byName.clear();
  loadedSourceLabel = sourceLabel;
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip trailing `;` comments.
    const line = rawLine.replace(/;.*$/, "").trim();
    if (line === "" || line.startsWith("[")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const bank = parseInt(m[1]!, 16);
    const addr = parseInt(m[2]!, 16);
    const name = m[3]!;
    const entry: SymbolEntry = { bank, addr, name };
    byKey.set(makeKey(bank, addr), entry);
    if (!byName.has(name)) byName.set(name, entry);
    count++;
  }
  return count;
}

export function clearSymbols(): void {
  byKey.clear();
  byName.clear();
  loadedSourceLabel = "";
}

export function hasSymbols(): boolean {
  return byKey.size > 0;
}

export function symbolCount(): number {
  return byKey.size;
}

export function sourceLabel(): string {
  return loadedSourceLabel;
}

/**
 * Resolve an address to a symbol name. `currentBank` is used when the
 * address is in the banked ROM area (0x4000-0x7FFF). For bank-0 ROM it
 * looks up bank=0; for >= 0x8000 it falls back to a bank-agnostic
 * first-match scan since sym conventions vary for RAM / HRAM / VRAM.
 */
export function symbolFor(addr: number, currentBank: number): string | null {
  if (byKey.size === 0) return null;
  const a = addr & 0xffff;
  let bank = 0;
  if (a >= 0x4000 && a < 0x8000) bank = currentBank;
  const primary = byKey.get(makeKey(bank, a));
  if (primary) return primary.name;
  // Fallback: any bank at this address (useful for HRAM / WRAM / VRAM
  // symbols where sym files typically record bank=0 but some tools
  // emit the hardware page instead).
  if (a >= 0x8000) {
    for (const e of byKey.values()) if (e.addr === a) return e.name;
  }
  return null;
}

/** Reverse lookup — identifier → { bank, addr }. Returns null if unknown. */
export function addressFor(name: string): SymbolEntry | null {
  return byName.get(name) ?? null;
}

/** All known symbols, sorted by (bank, addr). Used by the pane's list. */
export function allSymbols(): SymbolEntry[] {
  return [...byKey.values()].sort((a, b) => a.bank - b.bank || a.addr - b.addr);
}
