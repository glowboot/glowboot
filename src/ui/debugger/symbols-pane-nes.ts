import { allSymbols, clearSymbols, hasSymbols, loadSymbols, sourceLabel, symbolCount } from "../../nes";
import { toast } from "../hud/toast.js";
import { lsGet, lsRemove, lsSet } from "../persistence/local-storage.js";
import { state } from "../state.js";
import { escapeHtml, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * NES symbols pane. Mirrors the GB / GBA symbols pane UX — file picker,
 * count + source label, search box, filtered list — with NES-specific
 * adaptations:
 *
 *   - **Flat 16-bit addresses, no bank dimension.** NES banking is
 *     mapper-specific and dynamic, so symbols key on the 16-bit CPU
 *     address only (correct for zero-page / RAM and the fixed PRG bank
 *     that most labels of interest live in). The list shows one column
 *     for the address.
 *   - **Self-restoring.** The NES rom-loader doesn't call back into this
 *     pane after constructing a console (unlike GB / GBA), so the pane
 *     hydrates from localStorage itself on `mount`, keyed by the loaded
 *     ROM's filename (`state.currentFilename`).
 *
 * The accepted file format is the flat 16-bit form the engine loader
 * understands — `AAAA name`, `$AAAA name`, and `.nl` name-list `$AAAA#name`
 * lines — so `.sym` / `.nl` / `.mlb` listings load without massaging.
 */

interface SymbolStorageMeta {
  label: string;
}

const SYMBOLS_KEY_PREFIX_NES = "nes-symbols-";
const SYMBOLS_META_SUFFIX_NES = "nes-symbols-meta";

function storageKeyForCart(): string | null {
  const name = state.currentFilename;
  if (!name) return null;
  const safe = name.replace(/[^A-Za-z0-9]/g, "_") || "untitled";
  return SYMBOLS_KEY_PREFIX_NES + safe;
}

/** Persist the raw symbol text + label for the current ROM so future
 *  sessions with the same file auto-load it. */
function persistSymbols(text: string, label: string): void {
  const key = storageKeyForCart();
  if (!key) return;
  lsSet(key, text);
  lsSet(key + ":" + SYMBOLS_META_SUFFIX_NES, JSON.stringify({ label }));
}

/** Hydrate the in-memory table from localStorage for the current ROM's
 *  filename. No-op if nothing's stored. The NES rom-loader doesn't
 *  auto-restore symbols, so the pane does it on mount. */
function restoreSymbolsForCurrentCart(): void {
  const key = storageKeyForCart();
  if (!key) return;
  const text = lsGet(key);
  if (!text) return;
  const metaRaw = lsGet(key + ":" + SYMBOLS_META_SUFFIX_NES);
  let meta: SymbolStorageMeta = { label: "stored" };
  if (metaRaw) {
    try {
      meta = JSON.parse(metaRaw) as SymbolStorageMeta;
    } catch {
      // Corrupt meta JSON — keep the default label, the text is still useful.
    }
  }
  const n = loadSymbols(text, meta.label);
  if (n > 0) console.info(`[Symbols] restored ${n} NES entries`);
}

interface Refs {
  status: HTMLElement;
  fileInput: HTMLInputElement;
  clearBtn: HTMLButtonElement;
  search: HTMLInputElement;
  list: HTMLDivElement;
}

let refs: Refs | null = null;
let lastQuery = "";

export const symbolsPaneNes: Pane = {
  id: "symbols",
  label: "Symbols",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-sym");

    const status = document.createElement("div");
    status.className = "sym-status";

    const controls = document.createElement("div");
    controls.className = "sym-controls";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".sym,.nl,.mlb,.txt,text/plain";
    fileInput.className = "sym-file-input";
    const loadLabel = document.createElement("label");
    loadLabel.className = "sym-load-btn";
    loadLabel.textContent = "Load symbol file";
    loadLabel.appendChild(fileInput);
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "sym-clear-btn";
    clearBtn.textContent = "Clear";
    controls.append(loadLabel, clearBtn);

    const search = document.createElement("input");
    search.type = "text";
    search.className = "sym-search";
    search.placeholder = "Filter…";
    search.value = lastQuery;

    const list = document.createElement("div");
    list.className = "sym-list";

    container.append(status, controls, search, list);
    refs = { status, fileInput, clearBtn, search, list };

    // The NES rom-loader doesn't hydrate symbols for us — do it here so
    // reopening a ROM that had a symbol file loaded restores it.
    if (!hasSymbols()) restoreSymbolsForCurrentCart();

    fileInput.addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      file.text().then(
        (text) => {
          const n = loadSymbols(text, file.name);
          if (n === 0) {
            toast("No symbols found in file");
            return;
          }
          persistSymbols(text, file.name);
          toast(`Loaded ${n} symbol${n === 1 ? "" : "s"}`);
          fileInput.value = "";
        },
        (err: unknown) => {
          console.warn("[Symbols] read failed:", err);
          toast("Could not read file");
        }
      );
    });

    clearBtn.addEventListener("click", () => {
      clearSymbols();
      const key = storageKeyForCart();
      if (key) {
        lsRemove(key);
        lsRemove(key + ":" + SYMBOLS_META_SUFFIX_NES);
      }
      toast("Symbols cleared");
    });

    search.addEventListener("input", () => {
      lastQuery = search.value;
    });
  },

  refresh(): void {
    if (!refs) return;
    if (!hasSymbols()) {
      refs.status.textContent = "No symbols loaded";
      refs.status.classList.remove("sym-status-loaded");
      refs.list.innerHTML = `<div class="sym-empty">Pick a symbol file to name addresses in Disasm, Call Stack, and Breakpoints. Accepts \`AAAA name\` per line — works with .sym, .nl name-lists, or .mlb listings.</div>`;
      return;
    }
    refs.status.textContent = `${symbolCount()} symbols loaded · ${sourceLabel()}`;
    refs.status.classList.add("sym-status-loaded");

    const q = refs.search.value.trim().toLowerCase();
    const all = allSymbols();
    const filtered = q === "" ? all.slice(0, 500) : all.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 500);
    const lines: string[] = [];
    for (const e of filtered) {
      lines.push(
        `<div class="sym-row">` +
          `<span class="sym-addr">${hex4(e.addr)}</span>` +
          `<span class="sym-name">${escapeHtml(e.name)}</span>` +
          `</div>`
      );
    }
    if (filtered.length === 0) {
      refs.list.innerHTML = `<div class="sym-empty">No matches</div>`;
    } else {
      refs.list.innerHTML = lines.join("");
      if (q === "" && all.length > 500) {
        refs.list.insertAdjacentHTML(
          "beforeend",
          `<div class="sym-empty">…and ${all.length - 500} more — use the filter to narrow.</div>`
        );
      }
    }
  }
};
