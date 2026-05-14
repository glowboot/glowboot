/**
 * Cheat database lookup against the libretro-database repo on GitHub,
 * served via jsdelivr's CDN for the actual file fetches.
 *
 * Two-step flow:
 *   1. `fetchIndex()` — one-shot listing of every .cht filename in the
 *      Game Boy + Game Boy Color directories, pulled through GitHub's
 *      Contents API and cached in localStorage for a week. Two network
 *      calls total (one per platform directory) on the cold path.
 *   2. `fetchCht(entry)` — pulls an individual .cht via jsdelivr so we
 *      don't burn GitHub API quota on bulk downloads.
 *
 * Titles in ROM headers ("POKEMON RED") rarely match the libretro
 * filenames ("Pokemon - Red Version (USA, Europe).cht") exactly, so
 * `searchIndex` does a normalised token overlap score rather than a
 * strict match — good enough to surface the right game as the top hit
 * for most popular releases.
 */

const GB_DIR = "Nintendo - Game Boy";
const GBC_DIR = "Nintendo - Game Boy Color";
const BASE_DIRS = [GB_DIR, GBC_DIR];

const GH_API = "https://api.github.com/repos/libretro/libretro-database/contents/cht";
const CDN_URL = "https://cdn.jsdelivr.net/gh/libretro/libretro-database@master/cht";

import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week

export interface IndexEntry {
  dir: string; // e.g. "Nintendo - Game Boy"
  filename: string; // without .cht extension
}

interface CachedIndex {
  ts: number;
  entries: IndexEntry[];
}

/**
 * Fetches (or returns cached) list of every .cht filename across the two
 * Game Boy directories. Safe to call repeatedly — cache is consulted first.
 */
export async function fetchIndex(): Promise<IndexEntry[]> {
  const cached = loadCache();
  if (cached && Date.now() - cached.ts < CACHE_TTL && cached.entries.length > 0) {
    return cached.entries;
  }
  const entries: IndexEntry[] = [];
  for (const dir of BASE_DIRS) {
    const url = `${GH_API}/${encodeURIComponent(dir)}`;
    const res = await fetch(url, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!res.ok) throw new Error(`GitHub ${res.status} for "${dir}"`);
    const items = (await res.json()) as Array<{ name: string; type: string }>;
    for (const it of items) {
      if (it.type !== "file" || !it.name.endsWith(".cht")) continue;
      entries.push({ dir, filename: it.name.slice(0, -".cht".length) });
    }
  }
  saveCache({ ts: Date.now(), entries });
  return entries;
}

/** Download the text of one .cht file through jsdelivr. */
export async function fetchCht(entry: IndexEntry): Promise<string> {
  const url = `${CDN_URL}/${encodeURIComponent(entry.dir)}/${encodeURIComponent(entry.filename)}.cht`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN ${res.status} for ${entry.filename}`);
  return await res.text();
}

/**
 * Rank index entries against a free-text query (typically cart.title).
 * Score = sum of query-token lengths that appear in the normalised
 * filename, so "pokemon red" scores "Pokemon - Red Version" higher than
 * "Pokemon - Yellow Version".
 */
export function searchIndex(entries: IndexEntry[], query: string, limit = 30): IndexEntry[] {
  const tokens = normalise(query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const scored: { e: IndexEntry; score: number }[] = [];
  for (const e of entries) {
    const name = normalise(e.filename);
    let score = 0;
    for (const t of tokens) if (name.includes(t)) score += t.length;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loadCache(): CachedIndex | null {
  const raw = lsGet(KEYS.CHEAT_INDEX_CACHE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedIndex;
  } catch {
    return null;
  }
}

function saveCache(c: CachedIndex): void {
  lsSet(KEYS.CHEAT_INDEX_CACHE, JSON.stringify(c));
}
