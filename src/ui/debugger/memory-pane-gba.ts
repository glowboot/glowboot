import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { hex2, hex8 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * GBA memory viewer — hex grid + inline editor, parallel to the GB
 * memory pane.
 *
 * Address-space difference vs GB:
 *   - GB is a flat 64 KiB scroller (4096 rows).
 *   - GBA is sparse over 4 GiB: BIOS at 0x00, EWRAM at 0x02, IWRAM
 *     at 0x03, I/O at 0x04, palette at 0x05, VRAM at 0x06, OAM at
 *     0x07, ROM at 0x08-0x0D, SRAM at 0x0E. A single 256M-row
 *     scroller would blow past the browser's scroll-extent cap;
 *     instead we expose one segment at a time and switch via toolbar
 *     pills. Jump-to-address parses an 8-hex value and picks the
 *     right segment before scrolling.
 *
 * ROM segment is capped at MAX_ROM_ROWS so the spacer stays sane on a
 * 32-MiB cart. Bigger ROM offsets are still reachable via the address
 * input — paint the requested row inside the cap by virtually
 * re-basing the segment to the requested offset.
 *
 * Reads / writes route through `gba.mem.bus.read8 / write8` so bus
 * side-effects (palette mirroring, OAM writes, MMIO handlers) fire
 * the same way they would for cart code.
 */

const BYTES_PER_ROW = 16;
const ROW_HEIGHT_PX = 18;
const MAX_ROM_ROWS = 65536; // 1 MiB visible at a time on the ROM segment

interface Segment {
  id: string;
  label: string;
  base: number;
  /** Visible byte count. ROM may be larger than this on the live
   *  cart — the cap exists so the virtual-scroll spacer doesn't
   *  exceed the browser's per-element height limit. */
  length: number;
  cls: string;
}

const SEGMENTS: readonly Segment[] = [
  { id: "bios", label: "BIOS", base: 0x00000000, length: 0x4000, cls: "mem-region-bios" },
  { id: "ewram", label: "EWRAM", base: 0x02000000, length: 0x40000, cls: "mem-region-wram" },
  { id: "iwram", label: "IWRAM", base: 0x03000000, length: 0x8000, cls: "mem-region-iwram" },
  { id: "io", label: "I/O", base: 0x04000000, length: 0x400, cls: "mem-region-io" },
  { id: "pal", label: "PAL", base: 0x05000000, length: 0x400, cls: "mem-region-pal" },
  { id: "vram", label: "VRAM", base: 0x06000000, length: 0x18000, cls: "mem-region-vram" },
  { id: "oam", label: "OAM", base: 0x07000000, length: 0x400, cls: "mem-region-oam" },
  { id: "rom", label: "ROM", base: 0x08000000, length: MAX_ROM_ROWS * BYTES_PER_ROW, cls: "mem-region-rom" },
  { id: "sram", label: "SRAM", base: 0x0e000000, length: 0x10000, cls: "mem-region-sram" }
];

interface Refs {
  scroller: HTMLDivElement;
  spacer: HTMLDivElement;
  table: HTMLTableElement;
  viewport: HTMLTableSectionElement;
  jump: HTMLInputElement;
  undoBtn: HTMLButtonElement;
  segButtons: HTMLButtonElement[];
  rows: Array<{
    tr: HTMLTableRowElement;
    addrCell: HTMLTableCellElement;
    hexCells: HTMLTableCellElement[];
    asciiCell: HTMLTableCellElement;
  }>;
}

let refs: Refs | null = null;
let activeSegment: Segment = SEGMENTS[1]!; // EWRAM is the most common "where is my variable" target

const UNDO_LIMIT = 100;
const undoStack: Array<{ addr: number; prevValue: number }> = [];
let activeEditor: { cell: HTMLTableCellElement; input: HTMLInputElement; addr: number } | null = null;

export const memoryPaneGba: Pane = {
  id: "memory",
  label: "Memory",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-memory");

    const toolbar = document.createElement("div");
    toolbar.className = "memory-toolbar";

    const jumpLabel = document.createElement("label");
    jumpLabel.className = "memory-jump-label";
    jumpLabel.textContent = "Go to";
    const jump = document.createElement("input");
    jump.type = "text";
    jump.className = "memory-jump-input";
    jump.placeholder = "e.g. 02001234";
    jump.spellcheck = false;
    jump.maxLength = 8;
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

    const legend = document.createElement("div");
    legend.className = "memory-legend";
    const segButtons: HTMLButtonElement[] = [];
    for (const seg of SEGMENTS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `memory-legend-item ${seg.cls}`;
      item.textContent = seg.label;
      item.title = `Switch to ${seg.label} (${hex8(seg.base)})`;
      item.dataset.seg = seg.id;
      item.addEventListener("click", () => switchSegment(seg));
      legend.appendChild(item);
      segButtons.push(item);
    }
    toolbar.appendChild(legend);
    container.appendChild(toolbar);

    const scroller = document.createElement("div");
    scroller.className = "memory-scroller";
    const spacer = document.createElement("div");
    spacer.className = "memory-spacer";

    const table = document.createElement("table");
    table.className = "memory-table";
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);

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
    table.style.position = "absolute";
    table.style.top = "0";
    table.style.left = "0";
    table.style.width = "100%";
    scroller.style.position = "relative";
    container.appendChild(scroller);

    refs = { scroller, spacer, table, viewport: tbody, jump, undoBtn, segButtons, rows };

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
      if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) {
        jump.classList.remove("memory-jump-invalid");
        void jump.offsetWidth;
        jump.classList.add("memory-jump-invalid");
        return;
      }
      jumpToAddress(n >>> 0);
    });
    jump.addEventListener("input", () => jump.classList.remove("memory-jump-invalid"));

    applySegment(activeSegment);
    requestAnimationFrame(() => paintRows(0));
  },

  refresh(): void {
    if (!refs) return;
    const firstRow = Math.floor(refs.scroller.scrollTop / ROW_HEIGHT_PX);
    paintRows(firstRow);
  }
};

function applySegment(seg: Segment): void {
  if (!refs) return;
  activeSegment = seg;
  const totalRows = Math.ceil(seg.length / BYTES_PER_ROW);
  refs.spacer.style.height = `${totalRows * ROW_HEIGHT_PX}px`;
  refs.scroller.scrollTop = 0;
  refs.table.style.transform = "translateY(0)";
  for (const b of refs.segButtons) {
    b.classList.toggle("is-active", b.dataset.seg === seg.id);
  }
  paintRows(0);
}

function switchSegment(seg: Segment): void {
  if (seg.id === activeSegment.id) {
    if (refs) refs.scroller.scrollTop = 0;
    return;
  }
  applySegment(seg);
}

function jumpToAddress(addr: number): void {
  const seg = SEGMENTS.find((s) => addr >= s.base && addr < s.base + s.length);
  if (!seg) {
    toast(`No segment covers ${hex8(addr)}`);
    return;
  }
  if (seg.id !== activeSegment.id) applySegment(seg);
  if (!refs) return;
  const offset = addr - seg.base;
  const row = Math.floor(offset / BYTES_PER_ROW);
  refs.scroller.scrollTop = row * ROW_HEIGHT_PX;
}

function paintRows(firstRow: number): void {
  if (!refs) return;
  const gba = state.gba;
  const seg = activeSegment;
  const totalRows = Math.ceil(seg.length / BYTES_PER_ROW);
  for (let i = 0; i < refs.rows.length; i++) {
    const rowIdx = firstRow + i;
    const row = refs.rows[i]!;
    if (rowIdx >= totalRows) {
      row.tr.style.display = "none";
      continue;
    }
    row.tr.style.display = "";
    const baseAddr = (seg.base + rowIdx * BYTES_PER_ROW) >>> 0;
    row.addrCell.textContent = hex8(baseAddr).slice(1);
    row.addrCell.className = `memory-addr ${seg.cls}`;
    let ascii = "";
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      const addr = (baseAddr + j) >>> 0;
      const cell = row.hexCells[j]!;
      cell.dataset.addr = String(addr);
      if (activeEditor && activeEditor.cell === cell) continue;
      const v = gba ? gba.mem.bus.read8(addr) & 0xff : 0;
      cell.textContent = hex2(v).slice(1);
      ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : ".";
    }
    row.asciiCell.textContent = ascii;
  }
}

function beginEdit(cell: HTMLTableCellElement): void {
  const addrStr = cell.dataset.addr;
  if (addrStr === undefined) return;
  const addr = parseInt(addrStr, 10);
  if (!Number.isFinite(addr)) return;
  if (activeEditor) cancelEdit();

  const current = state.gba?.mem.bus.read8(addr) ?? 0;
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
  input.addEventListener("blur", () => {
    if (activeEditor?.input === input) commitEdit();
  });
}

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
  activeEditor = null;
  cell.textContent = hex2(n).slice(1);
}

function cancelEdit(): void {
  if (!activeEditor) return;
  const { cell, addr } = activeEditor;
  activeEditor = null;
  const v = state.gba?.mem.bus.read8(addr) ?? 0;
  cell.textContent = hex2(v).slice(1);
}

function writeByteWithUndo(addr: number, value: number, recordUndo: boolean): void {
  const gba = state.gba;
  if (!gba) return;
  const prev = gba.mem.bus.read8(addr) & 0xff;
  gba.mem.bus.write8(addr, value);
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
