/**
 * Cheat database lookup against the libretro-database repo on GitHub,
 * served via jsdelivr's CDN for the actual file fetches.
 *
 * Two-step flow:
 *   1. `fetchIndex(platform)` — listing of every .cht filename in the
 *      platform's libretro directories (GB + GBC for `"gb"`, one dir
 *      each for the rest). The Contents API caps a directory listing at
 *      1000 files, which truncates the large SNES/NES folders (thousands
 *      of .cht each) and silently drops late-alphabet games, so we resolve
 *      each folder's tree SHA from the parent listing and pull its *full*
 *      file list via the Git Trees API. Cached in localStorage for a week,
 *      keyed per-platform so the engines' caches don't interfere.
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
const NES_DIR = "Nintendo - Nintendo Entertainment System";
const SNES_DIR = "Nintendo - Super Nintendo Entertainment System";
const GB_DIRS = [GB_DIR, GBC_DIR];
const GBA_DIRS = [GBA_DIR];
const NES_DIRS = [NES_DIR];
const SNES_DIRS = [SNES_DIR];

/** Which platform's directories to fetch. Each platform's index is cached
 *  separately — the file formats differ enough (GBA codes are CodeBreaker,
 *  GB/NES codes are Game Genie + Game Shark) that mixing them in one search
 *  would confuse users. */
export type Platform = "gb" | "gba" | "nes" | "snes";

function dirsForPlatform(platform: Platform): readonly string[] {
  if (platform === "gba") return GBA_DIRS;
  if (platform === "nes") return NES_DIRS;
  if (platform === "snes") return SNES_DIRS;
  return GB_DIRS;
}

const GH_API = "https://api.github.com/repos/libretro/libretro-database/contents/cht";
const GH_TREES = "https://api.github.com/repos/libretro/libretro-database/git/trees";
const GH_HEADERS = { Accept: "application/vnd.github.v3+json" } as const;
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
 * first. Each platform's cache is keyed separately so a recent lookup on
 * one engine doesn't shadow a fresh fetch on another.
 */
export async function fetchIndex(platform: Platform = "gb"): Promise<IndexEntry[]> {
  const cached = loadCache(platform);
  if (cached && Date.now() - cached.ts < CACHE_TTL && cached.entries.length > 0) {
    return cached.entries;
  }
  const shaByDir = await fetchDirShas();
  const entries: IndexEntry[] = [];
  for (const dir of dirsForPlatform(platform)) {
    const sha = shaByDir.get(dir);
    if (!sha) throw new Error(`libretro-database: no "cht/${dir}" directory`);
    const res = await fetch(`${GH_TREES}/${sha}`, { headers: GH_HEADERS });
    if (!res.ok) throw new Error(`GitHub ${res.status} for tree "${dir}"`);
    const json = (await res.json()) as { tree: Array<{ path: string; type: string }> };
    for (const t of json.tree) {
      if (t.type !== "blob" || !t.path.endsWith(".cht")) continue;
      entries.push({ dir, filename: t.path.slice(0, -".cht".length) });
    }
  }
  saveCache(platform, { ts: Date.now(), entries });
  return entries;
}

/** Map each `cht/` sub-directory name to its Git tree SHA. The parent
 *  listing holds ~55 platform folders — well under the Contents API's
 *  1000-entry cap — so this one call is safe; the per-folder subtree it
 *  unlocks is what dodges the cap for the large console folders. */
async function fetchDirShas(): Promise<Map<string, string>> {
  const res = await fetch(GH_API, { headers: GH_HEADERS });
  if (!res.ok) throw new Error(`GitHub ${res.status} listing cht/`);
  const items = (await res.json()) as Array<{ name: string; type: string; sha: string }>;
  const map = new Map<string, string>();
  for (const it of items) if (it.type === "dir") map.set(it.name, it.sha);
  return map;
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
  // -v2: prior caches came from the Contents API and were truncated at
  // 1000 files (and SNES collided with the GB key), so bump the suffix to
  // discard them instead of serving a stale, incomplete index for a week.
  const suffix = platform === "gba" ? "-gba" : platform === "nes" ? "-nes" : platform === "snes" ? "-snes" : "";
  return `${KEYS.CHEAT_INDEX_CACHE}${suffix}-v2`;
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
