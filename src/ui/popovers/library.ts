import { recentsPop, recentsTrigger } from "../dom.js";
import { formatPlayTime, relativeTime } from "../format.js";
import { confirmAction } from "../hud/modal.js";
import { errorToast } from "../hud/toast.js";
import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";
import * as Recents from "../persistence/recents.js";
import { startEmulator } from "../rom-loader.js";
import { state } from "../state.js";
import { createPopover } from "./helper.js";

/**
 * Library popover — grid of cards for every previously-played ROM with
 * thumbnails and cumulative play time. Built from the IDB-backed
 * `recents` store; click a card to relaunch, hover for a × delete.
 *
 * The toolbar at the top exposes a plain-text search (case-insensitive
 * substring over title + filename, so the patch-suffix pill is also
 * searchable) and a sort mode. Both operate on an in-memory snapshot
 * of the IDB entries fetched at open-time, so typing doesn't hit the
 * database per keystroke.
 */

type SortMode = "recent" | "title" | "played";

function loadSort(): SortMode {
  const v = lsGet(KEYS.LIBRARY_SORT);
  return v === "title" || v === "played" ? v : "recent";
}

let entries: Recents.RecentEntry[] = [];
let searchTerm = "";
let sortMode: SortMode = loadSort();

/** Sync the Library trigger's disabled flag + title hint with the
 *  current entry count. Called whenever `entries` is mutated (load,
 *  ROM remember, forget) so the icon stays in step. Disabled when
 *  empty mirrors the rest of the action row's "load a ROM to use"
 *  pattern — prevents the user from opening a popover that just says
 *  "no games yet". */
function syncTriggerState(): void {
  if (!recentsTrigger) return;
  const hasEntries = entries.length > 0;
  recentsTrigger.disabled = !hasEntries;
  recentsTrigger.title = hasEntries ? "Library" : "Library — load a ROM to add it here";
}

// Eagerly hydrate the entry list at module load so the disabled
// state matches the persisted `recents` store from the very first
// paint. Same pattern as the printer popover — the icon would
// otherwise stay enabled (HTML default) until the user clicks it,
// which is the wrong direction.
void (async () => {
  try {
    entries = await Recents.list();
  } catch {
    entries = [];
  }
  syncTriggerState();
})();

function filterAndSort(): Recents.RecentEntry[] {
  const q = searchTerm.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => e.title.toLowerCase().includes(q) || e.filename.toLowerCase().includes(q))
    : entries.slice();
  switch (sortMode) {
    case "title":
      filtered.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "played":
      filtered.sort((a, b) => (b.totalPlayMs ?? 0) - (a.totalPlayMs ?? 0));
      break;
    case "recent":
    default:
      filtered.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
      break;
  }
  return filtered;
}

function renderGrid(container: HTMLElement): void {
  container.innerHTML = "";
  const items = filterAndSort();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pop-empty";
    empty.textContent = entries.length === 0 ? "No games yet — load a ROM to add it here" : "No matches";
    container.appendChild(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "library-card";
    card.title = `${item.title} • ${relativeTime(item.lastPlayedAt)}`;

    const thumb = document.createElement("div");
    thumb.className = "library-thumb";
    // Thumbnail goes on a CSS custom property rather than a direct
    // style.backgroundImage write so each card only registers one
    // style-property mutation instead of triggering the browser's
    // image-URL parse + cache-lookup path inline. Cards without a
    // thumbnail fall back to the em-dash placeholder.
    if (item.thumbnail) thumb.style.setProperty("--thumb", `url("${item.thumbnail}")`);
    else thumb.textContent = "—";
    // Surface a patch marker as a corner pill on the thumbnail: rom-loader
    // names patched entries as "{stem} [{patch}].gb", so a trailing
    // bracketed segment flags a hack / translation / randomizer variant.
    const patchMatch = item.filename.match(/\[([^\]]+)\]\.[^.]+$/);
    if (patchMatch) {
      const badge = document.createElement("span");
      badge.className = "library-patch";
      badge.textContent = patchMatch[1]!;
      badge.title = `Patched: ${patchMatch[1]}`;
      thumb.appendChild(badge);
    }

    const meta = document.createElement("div");
    meta.className = "library-meta";
    const title = document.createElement("span");
    title.className = "library-title";
    title.textContent = item.title;
    const time = document.createElement("span");
    time.className = "library-time";
    const played = item.totalPlayMs && item.totalPlayMs >= 60_000 ? ` · ${formatPlayTime(item.totalPlayMs)}` : "";
    time.textContent = relativeTime(item.lastPlayedAt) + played;
    meta.appendChild(title);
    meta.appendChild(time);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "library-action clear";
    del.title = "Remove from library";
    del.setAttribute("aria-label", `Remove ${item.title}`);
    del.textContent = "×";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await confirmAction({
        title: `Remove "${item.title}"?`,
        body: "The library entry, thumbnail, and play-time record will be deleted. Saves and save-states stay.",
        confirmLabel: "Remove",
        danger: true
      });
      if (!ok) return;
      await Recents.forget(item.id);
      entries = await Recents.list();
      syncTriggerState();
      renderGrid(container);
    });

    card.appendChild(thumb);
    card.appendChild(meta);
    card.appendChild(del);
    card.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeRecents();
      const bytes = await Recents.get(item.id);
      if (!bytes) {
        errorToast("ROM missing");
        return;
      }
      await startEmulator(bytes, item.filename, false);
      // Bump timestamp without re-writing the bytes.
      if (state.gb) await Recents.remember(state.gb.cart, bytes, item.filename);
    });
    container.appendChild(card);
  }
}

/** Aggregate stats across every recorded cart. Pure computation over
 *  the in-memory `entries` snapshot — no extra IDB reads. Returned as a
 *  plain shape so the renderer below can format each tile without
 *  recomputing. */
function computeStats(list: Recents.RecentEntry[]): {
  totalMs: number;
  cartCount: number;
  topCart: Recents.RecentEntry | null;
} {
  let totalMs = 0;
  let topCart: Recents.RecentEntry | null = null;
  for (const e of list) {
    const ms = e.totalPlayMs ?? 0;
    totalMs += ms;
    if (ms > (topCart?.totalPlayMs ?? 0)) topCart = e;
  }
  return { totalMs, cartCount: list.length, topCart };
}

function renderStats(container: HTMLElement): void {
  const { totalMs, cartCount, topCart } = computeStats(entries);
  if (entries.length === 0) return;

  const strip = document.createElement("div");
  strip.className = "library-stats";

  const tile = (label: string, value: string, title?: string): HTMLElement => {
    const t = document.createElement("div");
    t.className = "library-stat";
    if (title) t.title = title;
    const lbl = document.createElement("div");
    lbl.className = "library-stat-label";
    lbl.textContent = label;
    const val = document.createElement("div");
    val.className = "library-stat-value";
    val.textContent = value;
    t.appendChild(lbl);
    t.appendChild(val);
    return t;
  };

  // Play-time totals only kick in once a session passes the 60 s floor;
  // below that the tile shows a dash. Tooltip explains the threshold so
  // a user who just played a minute of a new cart isn't puzzled.
  const UNDER_MIN_HINT = "Play time shows up once a game has over a minute logged.";
  strip.appendChild(
    tile("Total play", totalMs >= 60_000 ? formatPlayTime(totalMs) : "—", totalMs < 60_000 ? UNDER_MIN_HINT : undefined)
  );
  strip.appendChild(tile("Carts", String(cartCount)));
  strip.appendChild(
    tile(
      "Most played",
      topCart && (topCart.totalPlayMs ?? 0) >= 60_000 ? topCart.title : "—",
      topCart && (topCart.totalPlayMs ?? 0) >= 60_000
        ? `${topCart.title} — ${formatPlayTime(topCart.totalPlayMs ?? 0)}`
        : UNDER_MIN_HINT
    )
  );

  container.appendChild(strip);
}

async function renderRecents(): Promise<void> {
  if (!recentsPop) return;
  // Paint a placeholder synchronously so the popover doesn't flash an
  // empty body between the `open` class toggle and the IDB fetch
  // resolving. On a populated library the async list() call otherwise
  // produces a visible jump from blank → full grid.
  recentsPop.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "pop-empty";
  loading.textContent = "Loading library…";
  recentsPop.appendChild(loading);

  entries = await Recents.list();
  syncTriggerState();
  recentsPop.innerHTML = "";

  renderStats(recentsPop);

  const toolbar = document.createElement("div");
  toolbar.className = "library-toolbar";

  const search = document.createElement("input");
  search.type = "search";
  search.className = "library-search";
  search.placeholder = "Search title…";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.value = searchTerm;

  const sort = document.createElement("select");
  sort.className = "library-sort";
  sort.title = "Sort order";
  for (const [value, label] of [
    ["recent", "Last played"],
    ["title", "Title A–Z"],
    ["played", "Most played"]
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sort.appendChild(opt);
  }
  sort.value = sortMode;

  toolbar.appendChild(search);
  toolbar.appendChild(sort);

  const grid = document.createElement("div");
  grid.className = "library-grid";

  recentsPop.appendChild(toolbar);
  recentsPop.appendChild(grid);

  // Re-render only the grid on input/sort changes — the toolbar itself
  // persists between keystrokes so focus/caret stay put. Debounce the
  // grid rebuild so a fast typist doesn't trigger a full querySelectorAll
  // + reflow per character; 120 ms is below perceptible input lag while
  // still coalescing normal typing cadence into a single render.
  let searchTimer: number | null = null;
  search.addEventListener("input", () => {
    searchTerm = search.value;
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      renderGrid(grid);
    }, 120);
  });
  sort.addEventListener("change", () => {
    sortMode = sort.value as SortMode;
    lsSet(KEYS.LIBRARY_SORT, sortMode);
    renderGrid(grid);
  });

  renderGrid(grid);
}

export const { open: openRecents, close: closeRecents } = createPopover({
  trigger: recentsTrigger,
  pop: recentsPop,
  // Reset the search term each time the popover opens so stale filters
  // don't hide entries the user expected to see on reopen. Sort mode
  // persists (user preference).
  onOpen: () => {
    searchTerm = "";
  },
  render: renderRecents
});
