/**
 * Cheat database lookup against the libretro-database repo on GitHub,
 * served via jsdelivr's CDN for the actual file fetches.
 *
 * Two-step flow:
 *   1. `fetchIndex(platform)` — one-shot listing of every .cht filename
 *      in the platform's libretro directories: GB + GBC for `"gb"` (two
 *      calls), Game Boy Advance for `"gba"` (one call). Pulled through
 *      GitHub's Contents API and cached in localStorage for a week,
 *      keyed per-platform so the two engines' caches don't interfere.
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
const GBA_DIR = "Nintendo - Game Boy Advance";
const GB_DIRS = [GB_DIR, GBC_DIR];
const GBA_DIRS = [GBA_DIR];

/** Which platform's directories to fetch. The GB/GBC indexes share a
 *  cache, the GBA index is separate — the file formats differ enough
 *  (GBA codes are CodeBreaker, GB codes are Game Genie + Game Shark)
 *  that mixing them in one search would confuse users. */
export type Platform = "gb" | "gba";

function dirsForPlatform(platform: Platform): readonly string[] {
  return platform === "gba" ? GBA_DIRS : GB_DIRS;
}

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
 * Fetches (or returns cached) list of every .cht filename across the
 * platform's directories. Safe to call repeatedly — cache is consulted
 * first. GB and GBA caches are keyed separately so a recent GB lookup
 * doesn't shadow a fresh GBA fetch.
 */
export async function fetchIndex(platform: Platform = "gb"): Promise<IndexEntry[]> {
  const cached = loadCache(platform);
  if (cached && Date.now() - cached.ts < CACHE_TTL && cached.entries.length > 0) {
    return cached.entries;
  }
  const entries: IndexEntry[] = [];
  for (const dir of dirsForPlatform(platform)) {
    const url = `${GH_API}/${encodeURIComponent(dir)}`;
    const res = await fetch(url, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!res.ok) throw new Error(`GitHub ${res.status} for "${dir}"`);
    const items = (await res.json()) as Array<{ name: string; type: string }>;
    for (const it of items) {
      if (it.type !== "file" || !it.name.endsWith(".cht")) continue;
      entries.push({ dir, filename: it.name.slice(0, -".cht".length) });
    }
  }
  saveCache(platform, { ts: Date.now(), entries });
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

function cacheKey(platform: Platform): string {
  return platform === "gba" ? `${KEYS.CHEAT_INDEX_CACHE}-gba` : KEYS.CHEAT_INDEX_CACHE;
}

function loadCache(platform: Platform): CachedIndex | null {
  const raw = lsGet(cacheKey(platform));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedIndex;
  } catch {
    return null;
  }
}

function saveCache(platform: Platform, c: CachedIndex): void {
  lsSet(cacheKey(platform), JSON.stringify(c));
}
