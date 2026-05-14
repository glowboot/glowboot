import { type CheatEntry, decodeCheat, formatCode, newCheatId } from "../../gb";
import * as CheatCDN from "../cheats/cdn.js";
import { parseCht } from "../cheats/parser.js";
import { renderScanner } from "../cheats/scanner.js";
import { cheatsPop, cheatsTrigger } from "../dom.js";
import { errorToast, toast } from "../hud/toast.js";
import * as Cheats from "../persistence/cheats.js";
import { state } from "../state.js";
import { createPopover } from "./helper.js";

/**
 * Cheats popover — per-cart Game Genie / Game Shark codes. Codes are
 * parsed, stored in IDB keyed by cartId, and applied via CheatManager
 * (MMU hook for Game Genie ROM patches, per-frame RAM writes for Game
 * Shark). Three entry paths: manual paste, .cht file import, and
 * online search via the libretro database.
 */

export const { open: openCheats, close: closeCheats } = createPopover({
  trigger: cheatsTrigger,
  pop: cheatsPop,
  render: renderCheats
});

/** Cached reference to the cheats-list div so mutation paths (add,
 *  delete, scanner freeze, bulk import) can refresh just the list
 *  without wiping the whole popover — wholesale re-render used to
 *  clobber user state in the scanner and online-search panels. */
let cheatListEl: HTMLDivElement | null = null;

function refreshCheatsList(): void {
  if (!cheatListEl) return;
  cheatListEl.innerHTML = "";
  const gb = state.gb;
  if (!gb) return;
  const entries = gb.cheats.entries;
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pop-empty";
    empty.textContent = "No cheats yet — paste a Game Genie or Game Shark code below";
    cheatListEl.appendChild(empty);
    return;
  }
  // Bulk toggle — flips between "Enable all" / "Disable all" based on
  // whether any cheat is currently off. Saves per-row clicking when
  // a user imports a .cht pack (30+ cheats, all initially disabled).
  const allOn = entries.every((e) => e.enabled);
  const bulk = document.createElement("button");
  bulk.type = "button";
  bulk.className = "cheats-bulk-toggle";
  bulk.textContent = allOn ? "Disable all" : "Enable all";
  bulk.addEventListener("click", () => {
    if (!state.gb) return;
    const turnOn = !allOn;
    for (const e of state.gb.cheats.entries) state.gb.cheats.setEnabled(e.id, turnOn);
    void Cheats.save(state.gb.cart, state.gb.cheats.entries);
    refreshCheatsList();
  });
  cheatListEl.appendChild(bulk);
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "cheat-row";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = e.enabled;
    chk.addEventListener("change", () => {
      if (!state.gb) return;
      state.gb.cheats.setEnabled(e.id, chk.checked);
      void Cheats.save(state.gb.cart, state.gb.cheats.entries);
    });
    row.appendChild(chk);

    const info = document.createElement("div");
    info.className = "cheat-info";
    const nameEl = document.createElement("div");
    nameEl.className = "cheat-name";
    nameEl.textContent = e.name || "(unnamed)";
    const codeEl = document.createElement("div");
    codeEl.className = "cheat-code";
    codeEl.appendChild(document.createTextNode(e.code + " "));
    const badge = document.createElement("span");
    badge.className = `cheat-format ${e.format === "game-shark" ? "gs" : "gg"}`;
    badge.textContent = e.format === "game-shark" ? "GS" : "GG";
    badge.title =
      e.format === "game-shark"
        ? "Game Shark — writes the value into RAM every frame so the game can't change it"
        : "Game Genie — patches ROM reads at fixed addresses (acts on cartridge code)";
    codeEl.appendChild(badge);
    info.appendChild(nameEl);
    info.appendChild(codeEl);
    row.appendChild(info);

    const del = document.createElement("button");
    del.className = "cheat-delete";
    del.title = "Delete cheat";
    del.setAttribute("aria-label", `Delete cheat ${e.name}`);
    del.textContent = "×";
    del.addEventListener("click", async () => {
      if (!state.gb) return;
      state.gb.cheats.remove(e.id);
      await Cheats.save(state.gb.cart, state.gb.cheats.entries);
      refreshCheatsList();
    });
    row.appendChild(del);

    cheatListEl.appendChild(row);
  }
}

async function renderCheats(): Promise<void> {
  if (!cheatsPop) return;
  cheatsPop.innerHTML = "";
  cheatListEl = null;
  const gb = state.gb;
  if (!gb) {
    const msg = document.createElement("div");
    msg.className = "pop-empty";
    msg.textContent = "Load a ROM to manage cheats";
    cheatsPop.appendChild(msg);
    return;
  }

  const list = document.createElement("div");
  list.className = "cheats-list";
  cheatListEl = list;
  cheatsPop.appendChild(list);
  refreshCheatsList();

  // Add form
  const form = document.createElement("form");
  form.className = "cheats-add";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Name";
  nameInput.autocomplete = "off";
  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.placeholder = "Code (e.g. 004-BCE-E66)";
  codeInput.autocomplete = "off";
  codeInput.spellcheck = false;
  // Live validation: non-empty + undecodable → .is-invalid, so the user
  // sees the error while still typing instead of only after pressing
  // Submit (which previously left the bad code in the field and moved
  // focus off it).
  codeInput.addEventListener("input", () => {
    const raw = codeInput.value.trim();
    codeInput.classList.toggle("is-invalid", raw.length > 0 && decodeCheat(raw) === null);
  });
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.textContent = "Add";
  form.appendChild(nameInput);
  form.appendChild(codeInput);
  form.appendChild(addBtn);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!state.gb) return;
    const raw = codeInput.value.trim();
    if (!raw) return;
    const decoded = decodeCheat(raw);
    if (!decoded) {
      errorToast("Invalid cheat code");
      return;
    }
    const entry: CheatEntry = {
      id: newCheatId(),
      name: nameInput.value.trim() || formatCode(raw),
      code: formatCode(raw),
      format: decoded.format,
      enabled: true,
      address: decoded.address,
      value: decoded.value,
      ...(decoded.compare !== undefined ? { compare: decoded.compare } : {})
    };
    state.gb.cheats.add(entry);
    await Cheats.save(state.gb.cart, state.gb.cheats.entries);
    nameInput.value = "";
    codeInput.value = "";
    toast(`Added ${decoded.format === "game-shark" ? "Game Shark" : "Game Genie"} cheat`);
    refreshCheatsList();
  });
  cheatsPop.appendChild(form);

  // Bulk import: both paths funnel through `importCheatsFromText`.
  const importRow = document.createElement("div");
  importRow.className = "cheats-import-row";
  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "cheats-import";
  importBtn.textContent = "Import .cht file…";
  const onlineBtn = document.createElement("button");
  onlineBtn.type = "button";
  onlineBtn.className = "cheats-import";
  onlineBtn.textContent = "Search online…";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".cht,.txt,text/plain";
  fileInput.hidden = true;
  const hint = document.createElement("a");
  hint.className = "cheats-hint";
  hint.href = "https://github.com/libretro/libretro-database/tree/master/cht";
  hint.target = "_blank";
  hint.rel = "noopener noreferrer";
  hint.textContent = "libretro-database";
  importRow.appendChild(importBtn);
  importRow.appendChild(onlineBtn);
  importRow.appendChild(hint);

  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      errorToast("Could not read file");
      return;
    }
    fileInput.value = "";
    await importCheatsFromText(text);
  });

  cheatsPop.appendChild(importRow);

  // Online search panel — hidden until the user clicks "Search online…".
  // Lazy-loads (and caches) the index on first use, then client-side
  // fuzzy-ranks as the user types.
  const searchPanel = document.createElement("div");
  searchPanel.className = "cheats-search";
  searchPanel.hidden = true;
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search game title…";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.className = "cheats-search-input";
  const resultsList = document.createElement("div");
  resultsList.className = "cheats-search-results";
  const searchStatus = document.createElement("div");
  searchStatus.className = "cheats-search-status";
  searchPanel.appendChild(searchInput);
  searchPanel.appendChild(searchStatus);
  searchPanel.appendChild(resultsList);
  cheatsPop.appendChild(searchPanel);
  cheatsPop.appendChild(fileInput);

  let cdnIndex: CheatCDN.IndexEntry[] | null = null;

  function renderSearchResults(): void {
    resultsList.innerHTML = "";
    if (!cdnIndex) return;
    const query = searchInput.value.trim();
    const matches = CheatCDN.searchIndex(cdnIndex, query, 30);
    if (matches.length === 0) {
      searchStatus.textContent = query ? "No matches" : "Type to search";
      return;
    }
    searchStatus.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
    for (const m of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cheats-search-result";
      const nm = document.createElement("span");
      nm.className = "r-name";
      nm.textContent = m.filename;
      const pl = document.createElement("span");
      pl.className = "r-plat";
      pl.textContent = m.dir.includes("Color") ? "GBC" : "GB";
      row.appendChild(nm);
      row.appendChild(pl);
      row.addEventListener("click", async () => {
        row.disabled = true;
        row.textContent = "Downloading…";
        try {
          const text = await CheatCDN.fetchCht(m);
          await importCheatsFromText(text);
        } catch (err) {
          console.warn("[Cheats] CDN fetch failed:", err);
          errorToast("Download failed");
          row.disabled = false;
          renderSearchResults();
        }
      });
      resultsList.appendChild(row);
    }
  }

  onlineBtn.addEventListener("click", async () => {
    const show = searchPanel.hidden;
    searchPanel.hidden = !show;
    if (!show) return;
    searchInput.value = state.gb?.cart.title.trim() || "";
    if (!cdnIndex) {
      searchStatus.textContent = "Loading database…";
      try {
        cdnIndex = await CheatCDN.fetchIndex();
      } catch (err) {
        console.warn("[Cheats] index fetch failed:", err);
        searchStatus.textContent = "Could not reach database";
        return;
      }
    }
    renderSearchResults();
    searchInput.focus();
  });
  searchInput.addEventListener("input", renderSearchResults);

  // Memory scanner — separate panel at the bottom of the popover. Its
  // "Freeze" button funnels through `gb.cheats.add`; we refresh only
  // the cheats list (not the whole popover) so the scanner's own DOM
  // state survives — user-typed filter values and the internal scan
  // state would otherwise vanish mid-session.
  renderScanner(cheatsPop, { onCheatAdded: refreshCheatsList });
}

/** Shared import pipeline for both file-picker and online-search paths. */
async function importCheatsFromText(text: string): Promise<void> {
  const gb = state.gb;
  if (!gb) return;
  const parsed = parseCht(text);
  let ok = 0;
  // Capture the specific entries that failed to decode so the user
  // isn't left with just "3 skipped" and no way to see what was wrong.
  // Toast hints at the console; full list goes through console.warn.
  const skipped: Array<{ name: string; code: string }> = [];
  for (const p of parsed) {
    const decoded = decodeCheat(p.code);
    if (!decoded) {
      skipped.push({ name: p.name, code: p.code });
      continue;
    }
    const entry: CheatEntry = {
      id: newCheatId(),
      name: p.name,
      code: formatCode(p.code),
      format: decoded.format,
      enabled: false,
      address: decoded.address,
      value: decoded.value,
      ...(decoded.compare !== undefined ? { compare: decoded.compare } : {})
    };
    gb.cheats.add(entry);
    ok++;
  }
  await Cheats.save(gb.cart, gb.cheats.entries);
  if (ok === 0 && skipped.length === 0) toast("No cheats found in file");
  else if (skipped.length > 0) {
    console.warn("[Cheats] skipped during import:", skipped);
    toast(`Imported ${ok} cheats (${skipped.length} skipped — see console)`);
  } else toast(`Imported ${ok} cheats`);
  refreshCheatsList();
}
