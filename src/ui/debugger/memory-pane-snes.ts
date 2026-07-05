import type { Snes } from "../../snes/snes.js";
import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * SNES memory viewer — read-only hex grid, parallel to the GBA memory
 * pane's segment-pill + virtual-scroll layout.
 *
 * Every region here has a plain backing array on the engine (WRAM,
 * SRAM, the raw ROM image, VRAM, CGRAM, OAM), so rows read those
 * directly instead of going through `bus.read` — the live bus mutates
 * the memory data register and fires MMIO side effects, which a
 * passive viewer must not do.
 *
 * WRAM keeps its real $7E0000 bus address; the other regions are
 * shown at raw offsets (ROM as image offsets — bank math depends on
 * LoROM/HiROM, and the flat image is what tile/table offsets in docs
 * refer to anyway). Go-to accepts either a $7Exxxx bus address (jumps
 * to WRAM) or an offset within the active region.
 */

const BYTES_PER_ROW = 16;
const ROW_HEIGHT_PX = 18;

interface Segment {
  id: string;
  label: string;
  base: number;
  length: number;
  cls: string;
  bytes: (snes: Snes) => Uint8Array;
}

function buildSegments(snes: Snes | null): Segment[] {
  const segments: Segment[] = [
    { id: "wram", label: "WRAM", base: 0x7e0000, length: 0x20000, cls: "mem-region-wram", bytes: (s) => s.bus.wram }
  ];
  const sramLen = snes?.bus.sram.length ?? 0;
  if (sramLen > 0) {
    segments.push({
      id: "sram",
      label: "SRAM",
      base: 0,
      length: sramLen,
      cls: "mem-region-sram",
      bytes: (s) => s.bus.sram
    });
  }
  segments.push(
    {
      id: "rom",
      label: "ROM (image)",
      base: 0,
      length: snes?.rom.rom.length ?? 0x8000,
      cls: "mem-region-rom",
      bytes: (s) => s.rom.rom
    },
    { id: "vram", label: "VRAM", base: 0, length: 0x10000, cls: "mem-region-vram", bytes: (s) => s.ppu.vram },
    { id: "cgram", label: "CGRAM", base: 0, length: 0x200, cls: "mem-region-pal", bytes: (s) => s.ppu.cgram },
    { id: "oam", label: "OAM", base: 0, length: 0x220, cls: "mem-region-oam", bytes: (s) => s.ppu.oam }
  );
  return segments;
}

interface Refs {
  scroller: HTMLDivElement;
  spacer: HTMLDivElement;
  table: HTMLTableElement;
  jump: HTMLInputElement;
  segButtons: HTMLButtonElement[];
  rows: Array<{
    tr: HTMLTableRowElement;
    addrCell: HTMLTableCellElement;
    hexCells: HTMLTableCellElement[];
    asciiCell: HTMLTableCellElement;
  }>;
}

let refs: Refs | null = null;
let segments: Segment[] = [];
let activeSegment: Segment | null = null;

export const memoryPaneSnes: Pane = {
  id: "memory",
  label: "Memory",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-memory");

    segments = buildSegments(state.snes);
    activeSegment = segments[0]!;

    const toolbar = document.createElement("div");
    toolbar.className = "memory-toolbar";

    const jumpLabel = document.createElement("label");
    jumpLabel.className = "memory-jump-label";
    jumpLabel.textContent = "Go to";
    const jump = document.createElement("input");
    jump.type = "text";
    jump.className = "memory-jump-input";
    jump.placeholder = "e.g. 7E0100";
    jump.spellcheck = false;
    jump.maxLength = 6;
    jumpLabel.appendChild(jump);
    toolbar.appendChild(jumpLabel);

    const legend = document.createElement("div");
    legend.className = "memory-legend";
    const segButtons: HTMLButtonElement[] = [];
    for (const seg of segments) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `memory-legend-item ${seg.cls}`;
      item.textContent = seg.label;
      item.title = `Switch to ${seg.label}`;
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

    refs = { scroller, spacer, table, jump, segButtons, rows };

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
      if (!Number.isFinite(n) || n < 0 || n > 0xffffff) {
        jump.classList.remove("memory-jump-invalid");
        void jump.offsetWidth;
        jump.classList.add("memory-jump-invalid");
        return;
      }
      jumpToAddress(n);
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
  if (seg.id === activeSegment?.id) {
    if (refs) refs.scroller.scrollTop = 0;
    return;
  }
  applySegment(seg);
}

function jumpToAddress(n: number): void {
  if (!refs || !activeSegment) return;
  // Regions with a real bus base (WRAM) are addressable from anywhere;
  // everything else treats the input as an offset within the active region.
  const covering = segments.find((s) => s.base > 0 && n >= s.base && n < s.base + s.length);
  let seg = activeSegment;
  let offset: number;
  if (covering) {
    seg = covering;
    offset = n - covering.base;
  } else if (n >= seg.base && n < seg.base + seg.length) {
    offset = n - seg.base;
  } else if (n < seg.length) {
    offset = n;
  } else {
    toast(`$${n.toString(16).toUpperCase()} is outside ${seg.label}`);
    return;
  }
  if (seg.id !== activeSegment.id) applySegment(seg);
  refs.scroller.scrollTop = Math.floor(offset / BYTES_PER_ROW) * ROW_HEIGHT_PX;
}

function paintRows(firstRow: number): void {
  if (!refs || !activeSegment) return;
  const snes = state.snes;
  const seg = activeSegment;
  const bytes = snes ? seg.bytes(snes) : null;
  const totalRows = Math.ceil(seg.length / BYTES_PER_ROW);
  for (let i = 0; i < refs.rows.length; i++) {
    const rowIdx = firstRow + i;
    const row = refs.rows[i]!;
    if (rowIdx >= totalRows) {
      row.tr.style.display = "none";
      continue;
    }
    row.tr.style.display = "";
    const baseOffset = rowIdx * BYTES_PER_ROW;
    row.addrCell.textContent = (seg.base + baseOffset).toString(16).padStart(6, "0").toUpperCase();
    row.addrCell.className = `memory-addr ${seg.cls}`;
    let ascii = "";
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      const off = baseOffset + j;
      const cell = row.hexCells[j]!;
      if (off >= seg.length) {
        cell.textContent = "";
        continue;
      }
      const v = bytes && off < bytes.length ? bytes[off]! & 0xff : 0;
      cell.textContent = v.toString(16).padStart(2, "0").toUpperCase();
      ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : ".";
    }
    row.asciiCell.textContent = ascii;
  }
}
