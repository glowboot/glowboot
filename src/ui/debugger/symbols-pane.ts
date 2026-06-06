import { allSymbols, clearSymbols, hasSymbols, loadSymbols, sourceLabel, symbolCount } from "../../gb";
import { toast } from "../hud/toast.js";
import { lsGet, lsRemove, lsSet, SYMBOLS_KEY_PREFIX, SYMBOLS_META_SUFFIX } from "../persistence/local-storage.js";
import { state } from "../state.js";
import { escapeHtml, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * Symbols pane for the Game Boy / Game Boy Color engine — load /
 * display a parsed RGBDS `.sym` file (`bank:addr name` lines). The
 * Game Boy Advance equivalent (`./symbols-pane-gba.ts`) accepts the
 * flat 32-bit address format (`AAAAAAAA NAME`, also `0x…` / `$…` /
 * `:` separators), which suits `nm` output and linker maps.
 *
 * UI: file picker → count + source label → search box → filtered list.
 *
 * Persistence: the parsed file's text is stashed in `localStorage` keyed
 * by the cart title so reopening the same game auto-restores it. The
 * clear button wipes both the in-memory store and the localStorage
 * entry for the current cart.
 */

interface SymbolStorageMeta {
  label: string;
}

function storageKeyForCart(): string | null {
  const gb = state.gb;
  if (!gb) return null;
  const safe = gb.cart.title.replace(/[^A-Za-z0-9]/g, "_") || "untitled";
  return SYMBOLS_KEY_PREFIX + safe;
}

/**
 * Persist the raw `.sym` text + label for the current cart so future
 * sessions with the same ROM auto-load it.
 */
function persistSymbols(text: string, label: string): void {
  const key = storageKeyForCart();
  if (!key) return;
  lsSet(key, text);
  lsSet(key + ":" + SYMBOLS_META_SUFFIX, JSON.stringify({ label }));
}

/**
 * Called by rom-loader right after a new GameBoy is constructed. Clears
 * the in-memory table and tries to hydrate from localStorage for the
 * new cart's title. No-op if nothing's stored for this cart.
 */
export function restoreSymbolsForCurrentCart(): void {
  clearSymbols();
  const key = storageKeyForCart();
  if (!key) return;
  const text = lsGet(key);
  if (!text) return;
  const metaRaw = lsGet(key + ":" + SYMBOLS_META_SUFFIX);
  let meta: SymbolStorageMeta = { label: "stored" };
  if (metaRaw) {
    try {
      meta = JSON.parse(metaRaw) as SymbolStorageMeta;
    } catch {
      // Corrupt meta JSON — keep the default label and continue;
      // a stored .sym text without a clean label is still useful.
    }
  }
  const n = loadSymbols(text, meta.label);
  if (n > 0) console.info(`[Symbols] restored ${n} entries for "${state.gb?.cart.title}"`);
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

export const symbolsPane: Pane = {
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
    fileInput.accept = ".sym,.txt,text/plain";
    fileInput.className = "sym-file-input";
    const loadLabel = document.createElement("label");
    loadLabel.className = "sym-load-btn";
    loadLabel.textContent = "Load .sym file";
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
        lsRemove(key + ":" + SYMBOLS_META_SUFFIX);
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
      refs.list.innerHTML = `<div class="sym-empty">Pick a .sym file to name addresses in Disasm, Call stack, and Breakpoints.</div>`;
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
          `<span class="sym-bank">${e.bank.toString(16).padStart(2, "0").toUpperCase()}</span>` +
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
