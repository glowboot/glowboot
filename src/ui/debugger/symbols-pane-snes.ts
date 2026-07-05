import {
  allSnesSymbols,
  clearSnesSymbols,
  hasSnesSymbols,
  loadSnesSymbols,
  snesSymbolCount,
  snesSymbolSourceLabel
} from "../../snes";
import { toast } from "../hud/toast.js";
import { lsGet, lsRemove, lsSet } from "../persistence/local-storage.js";
import * as Recents from "../persistence/recents.js";
import { state } from "../state.js";
import { escapeHtml, hex6 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * SNES symbols pane. Mirrors the GBA symbols pane's UX — file picker,
 * count + source label, search box, filtered list — with two
 * adaptations for SNES:
 *
 *   - **24-bit bank:offset addresses.** The engine-side parser accepts
 *     both `BB:AAAA NAME` (the common assembler .sym convention) and
 *     flat 6-hex-digit addresses; the list renders `$BB:AAAA`.
 *   - **Per-cart persistence keyed by `idForSnes(snes)`** so two carts
 *     with the same title (region variants, romhacks) keep separate
 *     symbol tables.
 */

const SYMBOLS_KEY_PREFIX_SNES = "snes-symbols-";
const SYMBOLS_META_SUFFIX_SNES = "snes-symbols-meta";

interface SnesSymbolStorageMeta {
  label: string;
}

function storageKeyForCart(): string | null {
  const snes = state.snes;
  if (!snes) return null;
  return SYMBOLS_KEY_PREFIX_SNES + Recents.idForSnes(snes);
}

function persistSnesSymbols(text: string, label: string): void {
  const key = storageKeyForCart();
  if (!key) return;
  lsSet(key, text);
  lsSet(key + ":" + SYMBOLS_META_SUFFIX_SNES, JSON.stringify({ label }));
}

/** Called by rom-loader right after a new Snes is constructed. Clears
 *  the in-memory table and tries to hydrate from localStorage for the
 *  new cart's id. No-op if nothing's stored. */
export function restoreSnesSymbolsForCurrentCart(): void {
  clearSnesSymbols();
  const key = storageKeyForCart();
  if (!key) return;
  const text = lsGet(key);
  if (!text) return;
  const metaRaw = lsGet(key + ":" + SYMBOLS_META_SUFFIX_SNES);
  let meta: SnesSymbolStorageMeta = { label: "stored" };
  if (metaRaw) {
    try {
      meta = JSON.parse(metaRaw) as SnesSymbolStorageMeta;
    } catch {
      // Corrupt meta JSON — keep the default label, the text is still useful.
    }
  }
  const n = loadSnesSymbols(text, meta.label);
  if (n > 0) console.info(`[Symbols] restored ${n} SNES entries`);
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

export const symbolsPaneSnes: Pane = {
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
    fileInput.accept = ".sym,.map,.txt,text/plain";
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

    fileInput.addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      file.text().then(
        (text) => {
          const n = loadSnesSymbols(text, file.name);
          if (n === 0) {
            toast("No symbols found in file");
            return;
          }
          persistSnesSymbols(text, file.name);
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
      clearSnesSymbols();
      const key = storageKeyForCart();
      if (key) {
        lsRemove(key);
        lsRemove(key + ":" + SYMBOLS_META_SUFFIX_SNES);
      }
      toast("Symbols cleared");
    });

    search.addEventListener("input", () => {
      lastQuery = search.value;
    });
  },

  refresh(): void {
    if (!refs) return;
    if (!hasSnesSymbols()) {
      refs.status.textContent = "No symbols loaded";
      refs.status.classList.remove("sym-status-loaded");
      refs.list.innerHTML = `<div class="sym-empty">Pick a symbol file to name addresses in Call stack and Breakpoints. Accepts \`BB:AAAA NAME\` or \`AAAAAA NAME\` per line — works with .sym files or .map excerpts.</div>`;
      return;
    }
    refs.status.textContent = `${snesSymbolCount()} symbols loaded · ${snesSymbolSourceLabel()}`;
    refs.status.classList.add("sym-status-loaded");

    const q = refs.search.value.trim().toLowerCase();
    const all = allSnesSymbols();
    const filtered = q === "" ? all.slice(0, 500) : all.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 500);
    const lines: string[] = [];
    for (const e of filtered) {
      lines.push(
        `<div class="sym-row">` +
          `<span class="sym-addr">${hex6(e.addr)}</span>` +
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
