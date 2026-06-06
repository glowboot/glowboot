import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { hex2, hex4, regionOf } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * Memory viewer for the Game Boy / Game Boy Color engine — hex grid
 * over the full 64 KiB address space plus an inline editor. The Game
 * Boy Advance equivalent (`./memory-pane-gba.ts`) is segmented (BIOS
 * / EWRAM / IWRAM / I/O / Palette / VRAM / OAM / ROM / SRAM) because
 * the 4 GiB GBA address space is too sparse for a single scroller.
 *
 * Layout is a `<table>` of rows, 16 bytes per row, with an address
 * gutter, 16 hex-byte columns, and an ASCII sidebar. The full
 * $0000-$FFFF range is 4096 rows; we render only the window that fits
 * in the scroll viewport (~40 rows) to keep the DOM tiny. Scrolling
 * a spacer pushes the window up/down.
 *
 * `refresh` only re-reads the currently-visible window — ~640 byte
 * reads per rAF tick, inexpensive. A "jump to address" input slams
 * the scroll position to the right row when the user wants to land
 * on a specific region.
 *
 * Click any byte to edit it inline. Enter writes the new value via
 * `mmu.writeByte` (so MBC side-effects like bank switches fire
 * normally), Escape cancels. A per-session undo stack lets the user
 * roll back individual edits with the Undo button in the toolbar.
 * Writes to the ROM address range hit the cart's MBC register
 * interface — that's intentional for testing bank-switch behaviour
 * but would surprise casual pokers; a toast warns on first use.
 */

const BYTES_PER_ROW = 16;
const ROW_HEIGHT_PX = 18;
const TOTAL_ROWS = 0x10000 / BYTES_PER_ROW; // 4096

interface Refs {
  scroller: HTMLDivElement;
  spacer: HTMLDivElement;
  viewport: HTMLTableSectionElement;
  jump: HTMLInputElement;
  undoBtn: HTMLButtonElement;
  rows: Array<{
    tr: HTMLTableRowElement;
    addrCell: HTMLTableCellElement;
    hexCells: HTMLTableCellElement[];
    asciiCell: HTMLTableCellElement;
  }>;
}

let refs: Refs | null = null;

/** Undo stack of committed edits. Capped at UNDO_LIMIT to keep memory
 *  bounded and to make "recent" actually recent. Grows only on
 *  successful writes, is drained oldest-first when full. */
const UNDO_LIMIT = 100;
const undoStack: Array<{ addr: number; prevValue: number }> = [];

/** Whether the "ROM writes land on the MBC" warning has been shown
 *  yet in this session. One toast is enough — we don't want to nag. */
let romWriteWarned = false;
/** Current in-flight inline editor (at most one at a time). Tracked
 *  so clicking a second cell commits the first, and so `refresh`
 *  skips re-rendering the cell whose text content is an `<input>`. */
let activeEditor: { cell: HTMLTableCellElement; input: HTMLInputElement; addr: number } | null = null;

export const memoryPane: Pane = {
  id: "memory",
  label: "Memory",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-memory");

    // Toolbar with a jump-to-address input.
    const toolbar = document.createElement("div");
    toolbar.className = "memory-toolbar";
    const jumpLabel = document.createElement("label");
    jumpLabel.className = "memory-jump-label";
    jumpLabel.textContent = "Go to";
    const jump = document.createElement("input");
    jump.type = "text";
    jump.className = "memory-jump-input";
    jump.placeholder = "e.g. C000";
    jump.spellcheck = false;
    jump.maxLength = 4;
    jumpLabel.appendChild(jump);
    toolbar.appendChild(jumpLabel);

    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "memory-undo-btn";
    undoBtn.textContent = "Undo";
    undoBtn.title = "Undo the most recent edit";
    undoBtn.disabled = true;
    undoBtn.addEventListener("click", () => undoEdit());
    toolbar.appendChild(undoBtn);

    // Region legend — colour key AND quick-jump buttons. Clicking any
    // item scrolls the viewport to the start of that region so you
    // don't have to remember the address (especially useful for I/O
    // and HRAM which sit at inconvenient hex addresses).
    const legend = document.createElement("div");
    legend.className = "memory-legend";
    for (const [label, cls, startAddr] of [
      ["ROM", "mem-region-rom", 0x0000],
      ["VRAM", "mem-region-vram", 0x8000],
      ["WRAM", "mem-region-wram", 0xc000],
      ["OAM", "mem-region-oam", 0xfe00],
      ["IO", "mem-region-io", 0xff00],
      ["HRAM", "mem-region-hram", 0xff80]
    ] as const) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `memory-legend-item ${cls}`;
      item.textContent = label;
      item.title = `Jump to $${startAddr.toString(16).toUpperCase().padStart(4, "0")}`;
      item.addEventListener("click", () => jumpToAddress(startAddr));
      legend.appendChild(item);
    }
    toolbar.appendChild(legend);
    container.appendChild(toolbar);

    // Scroller holds the virtual-scroll spacer + the visible rows.
    const scroller = document.createElement("div");
    scroller.className = "memory-scroller";
    const spacer = document.createElement("div");
    spacer.className = "memory-spacer";
    spacer.style.height = `${TOTAL_ROWS * ROW_HEIGHT_PX}px`;

    const table = document.createElement("table");
    table.className = "memory-table";
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);

    // Build enough row DOM nodes to cover a generous viewport. We only
    // update their contents + CSS `transform` on scroll; the node
    // count stays fixed. 60 rows × 18 px = 1080 px — taller than any
    // reasonable popover viewport.
    const visibleRowCount = 60;
    const rows: Refs["rows"] = [];
    for (let i = 0; i < visibleRowCount; i++) {
      const tr = document.createElement("tr");
      tr.className = "memory-row";
      const addrCell = document.createElement("td");
      addrCell.className = "memory-addr";
      tr.appendChild(addrCell);
      const hexCells: HTMLTableCellElement[] = [];
      for (let j = 0; j < BYTES_PER_ROW; j++) {
        const td = document.createElement("td");
        td.className = "memory-byte";
        td.title = "Click to edit";
        td.addEventListener("click", () => beginEdit(td));
        tr.appendChild(td);
        hexCells.push(td);
      }
      const asciiCell = document.createElement("td");
      asciiCell.className = "memory-ascii";
      tr.appendChild(asciiCell);
      tbody.appendChild(tr);
      rows.push({ tr, addrCell, hexCells, asciiCell });
    }

    scroller.append(spacer, table);
    // `table` is absolutely positioned inside the scroller; we move it
    // with `transform: translateY(...)` on each scroll event so the
    // browser's layout work stays O(visibleRowCount) instead of O(N).
    table.style.position = "absolute";
    table.style.top = "0";
    table.style.left = "0";
    table.style.width = "100%";
    scroller.style.position = "relative";
    container.appendChild(scroller);

    refs = { scroller, spacer, viewport: tbody, jump, undoBtn, rows };

    scroller.addEventListener("scroll", () => {
      if (!refs) return;
      const firstRow = Math.floor(scroller.scrollTop / ROW_HEIGHT_PX);
      table.style.transform = `translateY(${firstRow * ROW_HEIGHT_PX}px)`;
      paintRows(firstRow);
    });

    jump.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const raw = jump.value.replace(/^\$|^0x/i, "").trim();
      const n = parseInt(raw, 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) {
        // Flash the input red briefly so a silently-rejected jump
        // doesn't leave the user wondering whether Enter did anything.
        // Class is removed on any subsequent input so the next keystroke
        // clears the state without waiting for the timeout.
        jump.classList.remove("memory-jump-invalid");
        // Force a reflow so the animation restarts on rapid re-submits.
        void jump.offsetWidth;
        jump.classList.add("memory-jump-invalid");
        return;
      }
      jumpToAddress(n);
    });
    jump.addEventListener("input", () => jump.classList.remove("memory-jump-invalid"));

    // Initial paint after layout settles so `scrollTop` is 0.
    requestAnimationFrame(() => paintRows(0));
  },

  refresh(): void {
    if (!refs) return;
    const firstRow = Math.floor(refs.scroller.scrollTop / ROW_HEIGHT_PX);
    paintRows(firstRow);
  }
};

function jumpToAddress(addr: number): void {
  if (!refs) return;
  const row = Math.floor(addr / BYTES_PER_ROW);
  refs.scroller.scrollTop = row * ROW_HEIGHT_PX;
}

function paintRows(firstRow: number): void {
  if (!refs) return;
  const gb = state.gb;
  for (let i = 0; i < refs.rows.length; i++) {
    const rowIdx = firstRow + i;
    const row = refs.rows[i]!;
    if (rowIdx >= TOTAL_ROWS) {
      row.tr.style.display = "none";
      continue;
    }
    row.tr.style.display = "";
    const baseAddr = rowIdx * BYTES_PER_ROW;
    row.addrCell.textContent = hex4(baseAddr).slice(1); // strip the `$` — shorter in the gutter
    row.addrCell.className = `memory-addr ${regionClass(baseAddr)}`;
    let ascii = "";
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      const addr = baseAddr + j;
      const cell = row.hexCells[j]!;
      // Record the cell's current address on the DOM so click handlers
      // and the active-editor lookup don't have to recompute it from
      // indices. Doubles as the "which cell is being edited?" key.
      cell.dataset.addr = String(addr);
      // Leave the cell alone if it's the one currently being edited —
      // we'd otherwise blow away the <input> child and the user's
      // in-flight keystrokes.
      if (activeEditor && activeEditor.cell === cell) continue;
      const v = gb ? gb.mmu.readByte(addr) : 0;
      cell.textContent = hex2(v).slice(1);
      ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : ".";
    }
    row.asciiCell.textContent = ascii;
  }
}

/** Replace a hex cell's text content with an `<input>` pre-filled
 *  with the current value. The first click on a cell starts editing;
 *  clicking any other cell (or pressing Escape) cancels the in-flight
 *  edit before starting a new one. */
function beginEdit(cell: HTMLTableCellElement): void {
  const addrStr = cell.dataset.addr;
  if (addrStr === undefined) return;
  const addr = parseInt(addrStr, 10);
  if (!Number.isFinite(addr)) return;
  if (activeEditor) cancelEdit();

  const current = state.gb?.mmu.readByte(addr) ?? 0;
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 2;
  input.className = "memory-byte-editor";
  input.value = hex2(current).slice(1);
  input.spellcheck = false;

  cell.textContent = "";
  cell.appendChild(input);
  input.focus();
  input.select();

  activeEditor = { cell, input, addr };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  });
  // Blur commits — matches the convention of most hex editors (click
  // away = keep what you've typed). Use mousedown on the container to
  // commit BEFORE the next cell's click handler fires, so chained
  // edits don't lose the previous one's commit.
  input.addEventListener("blur", () => {
    if (activeEditor?.input === input) commitEdit();
  });
}

/** Parse the editor's current text as a hex byte and write it via
 *  `mmu.writeByte`. Does nothing if the text isn't valid — cancels
 *  without committing so the user can fix typos. */
function commitEdit(): void {
  if (!activeEditor) return;
  const { cell, input, addr } = activeEditor;
  const raw = input.value.trim();
  const n = parseInt(raw, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xff) {
    cancelEdit();
    return;
  }
  writeByteWithUndo(addr, n & 0xff, /* recordUndo */ true);
  // Restore the cell to plain text — `refresh` will pick up the fresh
  // value on the next tick, but paint it immediately so the user sees
  // the commit land without waiting.
  activeEditor = null;
  cell.textContent = hex2(n).slice(1);
}

/** Abort the in-flight edit; restore the cell's text from whatever
 *  the MMU currently holds (which may have changed while the user
 *  typed — the game keeps running, after all). */
function cancelEdit(): void {
  if (!activeEditor) return;
  const { cell, addr } = activeEditor;
  activeEditor = null;
  const v = state.gb?.mmu.readByte(addr) ?? 0;
  cell.textContent = hex2(v).slice(1);
}

function writeByteWithUndo(addr: number, value: number, recordUndo: boolean): void {
  const gb = state.gb;
  if (!gb) return;
  const prev = gb.mmu.readByte(addr);
  if (addr < 0x8000 && !romWriteWarned) {
    romWriteWarned = true;
    toast("Writes below $8000 go to the MBC — may switch banks");
  }
  gb.mmu.writeByte(addr, value);
  if (recordUndo) {
    undoStack.push({ addr, prevValue: prev });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    updateUndoButton();
  }
}

function undoEdit(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  writeByteWithUndo(entry.addr, entry.prevValue, /* recordUndo */ false);
  updateUndoButton();
}

function updateUndoButton(): void {
  if (!refs) return;
  refs.undoBtn.disabled = undoStack.length === 0;
  refs.undoBtn.title = undoStack.length === 0 ? "Nothing to undo" : `Undo last edit (${undoStack.length} in history)`;
}

function regionClass(addr: number): string {
  const r = regionOf(addr);
  if (r.startsWith("ROM")) return "mem-region-rom";
  if (r === "VRAM") return "mem-region-vram";
  if (r === "SRAM") return "mem-region-sram";
  if (r.startsWith("WRAM") || r === "ECHO") return "mem-region-wram";
  if (r === "OAM") return "mem-region-oam";
  if (r === "IO") return "mem-region-io";
  if (r === "HRAM" || r === "IE") return "mem-region-hram";
  return "";
}
