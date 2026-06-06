import {
  allGbaSymbols,
  clearGbaSymbols,
  gbaSymbolCount,
  gbaSymbolSourceLabel,
  hasGbaSymbols,
  loadGbaSymbols
} from "../../gba";
import { toast } from "../hud/toast.js";
import {
  lsGet,
  lsRemove,
  lsSet,
  SYMBOLS_KEY_PREFIX_GBA,
  SYMBOLS_META_SUFFIX_GBA
} from "../persistence/local-storage.js";
import * as Recents from "../persistence/recents.js";
import { state } from "../state.js";
import { escapeHtml, hex8 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * GBA symbols pane. Mirrors the GB symbols pane's UX — file picker,
 * count + source label, search box, filtered list — with two
 * adaptations for GBA:
 *
 *   - **No bank dimension.** GBA cart ROM is mapped linearly (no MBC),
 *     so addresses are unambiguous 32-bit values. The list shows one
 *     column for the address instead of bank + offset.
 *   - **Per-cart persistence keyed by `idForGba(gba)`.** The GB pane
 *     keys by sanitised cart title; we use the Recents library id so
 *     two GBA carts with the same title (region variants, romhacks)
 *     keep separate symbol tables.
 *
 * The accepted file format is more permissive than `.sym` —
 * `[0x|$]AAAAAAAA[:]  NAME` per line, blank + comment lines skipped —
 * so pasting `nm` output or a build-log map excerpt works without
 * massaging.
 */

interface GbaSymbolStorageMeta {
  label: string;
}

function storageKeyForCart(): string | null {
  const gba = state.gba;
  if (!gba) return null;
  // idForGba is a stable hash of header bytes + ROM length, so two
  // carts that *happen* to share a title don't share a symbol table.
  return SYMBOLS_KEY_PREFIX_GBA + Recents.idForGba(gba);
}

function persistGbaSymbols(text: string, label: string): void {
  const key = storageKeyForCart();
  if (!key) return;
  lsSet(key, text);
  lsSet(key + ":" + SYMBOLS_META_SUFFIX_GBA, JSON.stringify({ label }));
}

/** Called by rom-loader right after a new Gba is constructed. Clears
 *  the in-memory table and tries to hydrate from localStorage for the
 *  new cart's id. No-op if nothing's stored. */
export function restoreGbaSymbolsForCurrentCart(): void {
  clearGbaSymbols();
  const key = storageKeyForCart();
  if (!key) return;
  const text = lsGet(key);
  if (!text) return;
  const metaRaw = lsGet(key + ":" + SYMBOLS_META_SUFFIX_GBA);
  let meta: GbaSymbolStorageMeta = { label: "stored" };
  if (metaRaw) {
    try {
      meta = JSON.parse(metaRaw) as GbaSymbolStorageMeta;
    } catch {
      // Corrupt meta JSON — keep the default label, the text is still useful.
    }
  }
  const n = loadGbaSymbols(text, meta.label);
  if (n > 0) console.info(`[Symbols] restored ${n} GBA entries`);
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

export const symbolsPaneGba: Pane = {
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
          const n = loadGbaSymbols(text, file.name);
          if (n === 0) {
            toast("No symbols found in file");
            return;
          }
          persistGbaSymbols(text, file.name);
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
      clearGbaSymbols();
      const key = storageKeyForCart();
      if (key) {
        lsRemove(key);
        lsRemove(key + ":" + SYMBOLS_META_SUFFIX_GBA);
      }
      toast("Symbols cleared");
    });

    search.addEventListener("input", () => {
      lastQuery = search.value;
    });
  },

  refresh(): void {
    if (!refs) return;
    if (!hasGbaSymbols()) {
      refs.status.textContent = "No symbols loaded";
      refs.status.classList.remove("sym-status-loaded");
      refs.list.innerHTML = `<div class="sym-empty">Pick a symbol file to name addresses in Disasm, Call stack, and Breakpoints. Accepts \`AAAAAAAA NAME\` per line — works with .sym, nm output, or .map excerpts.</div>`;
      return;
    }
    refs.status.textContent = `${gbaSymbolCount()} symbols loaded · ${gbaSymbolSourceLabel()}`;
    refs.status.classList.add("sym-status-loaded");

    const q = refs.search.value.trim().toLowerCase();
    const all = allGbaSymbols();
    const filtered = q === "" ? all.slice(0, 500) : all.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 500);
    const lines: string[] = [];
    for (const e of filtered) {
      lines.push(
        `<div class="sym-row">` +
          `<span class="sym-addr">${hex8(e.addr)}</span>` +
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
