import { decodeArm, decodeThumb, gbaSymbolFor, hasGbaPcBreakpoint, toggleGbaPcBreakpoint } from "../../gba";
import { state } from "../state.js";
import { hex2, hex8 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * GBA live-disassembly pane. Parallel to `./disasm-pane.ts` (GB), but
 * with GBA-specific simplifications:
 *
 *   - **Fixed instruction size.** ARM is always 4 bytes, Thumb always
 *     2 bytes — no walk-forward heuristic needed for backward extension.
 *     The previous instruction's address is always `addr - instrSize`,
 *     so prepending a chunk is just stepping back N × instrSize.
 *   - **Mode follow.** CPSR.T decides ARM (4-byte) vs Thumb (2-byte).
 *     We re-seed the window whenever the mode changes so the user
 *     doesn't see a confused mix.
 *   - **No symbol resolution yet.** Targets render as plain `$XXXXXXXX`
 *     hex; the symbols pane (Phase 4d) will hook in here later.
 *
 * Refresh repaints PC highlight + breakpoint dots on the existing
 * window. If PC has moved outside it (big branch / mode switch / pane
 * was seeded far away), the user keeps their scroll position — the
 * Step / Run controls in the orchestrator can call `scrollGbaDisasmToPc`
 * to bring focus back.
 */

const INITIAL_LINES_BEFORE = 16;
const INITIAL_LINES_AFTER = 150;
const ROW_HEIGHT_PX = 18;
const PC_CONTEXT_ROWS = 5;
const EXTEND_THRESHOLD_PX = 200;
const EXTEND_LINES = 80;

interface Row {
  el: HTMLDivElement;
  bp: HTMLSpanElement;
  addrEl: HTMLSpanElement;
  bytesEl: HTMLSpanElement;
  mnEl: HTMLSpanElement;
  opEl: HTMLSpanElement;
  addr: number;
  length: number;
}

interface Refs {
  list: HTMLDivElement;
  rows: Row[];
  /** ARM vs Thumb at last seed. The refresh path re-seeds when this
   *  doesn't match the live CPSR.T so a `bx` to the other mode doesn't
   *  leave the user reading garbage decodes. */
  thumb: boolean;
}

let refs: Refs | null = null;

function createRow(): Row {
  const el = document.createElement("div");
  el.className = "disasm-row";
  const bp = document.createElement("span");
  bp.className = "disasm-bp";
  bp.title = "Click to toggle breakpoint";
  const addr = document.createElement("span");
  addr.className = "disasm-addr";
  const bytes = document.createElement("span");
  bytes.className = "disasm-bytes";
  const mn = document.createElement("span");
  mn.className = "disasm-mnemonic";
  const op = document.createElement("span");
  op.className = "disasm-operands";
  el.append(bp, addr, bytes, mn, op);
  return { el, bp, addrEl: addr, bytesEl: bytes, mnEl: mn, opEl: op, addr: 0, length: 4 };
}

function decodeAt(
  addr: number,
  thumb: boolean
): { mnemonic: string; operands: string; length: number; bytesText: string } {
  const gba = state.gba;
  if (!gba) return { mnemonic: ".word", operands: "—", length: thumb ? 2 : 4, bytesText: "" };
  if (thumb) {
    const op = gba.mem.bus.read16(addr) & 0xffff;
    const dec = decodeThumb(op, addr);
    const lo = op & 0xff;
    const hi = (op >>> 8) & 0xff;
    return {
      mnemonic: dec.mnemonic,
      operands: applySymbol(dec.operands, dec.targetAddr),
      length: 2,
      bytesText: `${hex2(lo).slice(1)} ${hex2(hi).slice(1)}`
    };
  }
  const op = gba.mem.bus.read32(addr) >>> 0;
  const dec = decodeArm(op, addr);
  const b0 = op & 0xff;
  const b1 = (op >>> 8) & 0xff;
  const b2 = (op >>> 16) & 0xff;
  const b3 = (op >>> 24) & 0xff;
  return {
    mnemonic: dec.mnemonic,
    operands: applySymbol(dec.operands, dec.targetAddr),
    length: 4,
    bytesText: `${hex2(b0).slice(1)} ${hex2(b1).slice(1)} ${hex2(b2).slice(1)} ${hex2(b3).slice(1)}`
  };
}

/** Replace the decoder's raw hex target with a loaded symbol's name
 *  when one is registered for that address. Same string-replace
 *  pattern the GB disasm pane uses. */
function applySymbol(operands: string, targetAddr: number | undefined): string {
  if (targetAddr === undefined) return operands;
  const sym = gbaSymbolFor(targetAddr);
  if (!sym) return operands;
  return operands.replace(hex8(targetAddr), sym);
}

function paintRow(row: Row, addr: number, thumb: boolean): void {
  const d = decodeAt(addr, thumb);
  row.addr = addr;
  row.length = d.length;
  row.el.dataset.target = (addr >>> 0).toString(16);
  row.addrEl.textContent = hex8(addr).slice(1);
  row.bytesEl.textContent = d.bytesText;
  row.mnEl.textContent = d.mnemonic;
  row.opEl.textContent = d.operands;
}

function seedWindow(pc: number, thumb: boolean): void {
  if (!refs) return;
  refs.list.innerHTML = "";
  refs.rows = [];
  refs.thumb = thumb;
  const instrSize = thumb ? 2 : 4;
  // Align PC down to instruction boundary — engine should always be
  // aligned, but defensive in case the disasm is opened at an odd
  // moment.
  const alignedPc = (pc - (pc % instrSize)) >>> 0;
  let addr = (alignedPc - INITIAL_LINES_BEFORE * instrSize) >>> 0;
  // Clamp so the window doesn't wrap past 0; addresses below the
  // current segment are usually open-bus.
  if (addr > alignedPc) addr = 0;
  const total = INITIAL_LINES_BEFORE + 1 + INITIAL_LINES_AFTER;
  for (let i = 0; i < total; i++) {
    const row = createRow();
    paintRow(row, addr, thumb);
    refs.list.appendChild(row.el);
    refs.rows.push(row);
    addr = (addr + instrSize) >>> 0;
  }
  queueMicrotask(() => {
    if (!refs) return;
    const pcRow = refs.rows.find((r) => r.addr === alignedPc);
    if (pcRow) refs.list.scrollTop = Math.max(0, pcRow.el.offsetTop - PC_CONTEXT_ROWS * ROW_HEIGHT_PX);
  });
}

function extendForward(count: number): void {
  if (!refs || refs.rows.length === 0) return;
  const last = refs.rows[refs.rows.length - 1]!;
  const instrSize = refs.thumb ? 2 : 4;
  let addr = (last.addr + last.length) >>> 0;
  for (let i = 0; i < count; i++) {
    const row = createRow();
    paintRow(row, addr, refs.thumb);
    refs.list.appendChild(row.el);
    refs.rows.push(row);
    const next = (addr + instrSize) >>> 0;
    if (next < addr) break; // wrap-around guard
    addr = next;
  }
}

function extendBackward(count: number): void {
  if (!refs || refs.rows.length === 0) return;
  const head = refs.rows[0]!.addr;
  if (head === 0) return;
  const instrSize = refs.thumb ? 2 : 4;
  const startAddr = Math.max(0, head - count * instrSize);
  const toAdd: Row[] = [];
  let addr = startAddr;
  while (addr < head) {
    const row = createRow();
    paintRow(row, addr, refs.thumb);
    toAdd.push(row);
    addr += instrSize;
  }
  if (toAdd.length === 0) return;
  const scrollBefore = refs.list.scrollTop;
  const firstRowEl = refs.rows[0]!.el;
  for (let i = 0; i < toAdd.length; i++) {
    refs.list.insertBefore(toAdd[i]!.el, firstRowEl);
  }
  refs.rows = [...toAdd, ...refs.rows];
  const newFirstRowEl = refs.rows[0]!.el;
  const addedHeight = firstRowEl.offsetTop - newFirstRowEl.offsetTop;
  refs.list.scrollTop = scrollBefore + addedHeight;
}

function updateMarkers(): void {
  if (!refs) return;
  const gba = state.gba;
  const pc = gba?.cpu.regs.r[15];
  for (const row of refs.rows) {
    const isCurrent = pc !== undefined && row.addr === pc >>> 0;
    row.el.classList.toggle("disasm-row-current", isCurrent);
    const hasBp = hasGbaPcBreakpoint(row.addr);
    row.el.classList.toggle("disasm-row-bp", hasBp);
    row.bp.textContent = hasBp ? "●" : "";
  }
}

/** Scroll the list so the current PC row is visible. If PC is outside
 *  the window OR the mode changed, re-seeds. Called by orchestrator
 *  control bar (Step / Continue) so stepping always brings focus back. */
export function scrollGbaDisasmToPc(): void {
  if (!refs) return;
  const gba = state.gba;
  if (!gba) return;
  const thumb = gba.cpu.regs.tFlag;
  const pc = gba.cpu.regs.r[15]! >>> 0;
  if (thumb !== refs.thumb) {
    seedWindow(pc, thumb);
    return;
  }
  const pcRow = refs.rows.find((r) => r.addr === pc);
  if (pcRow) {
    refs.list.scrollTop = Math.max(0, pcRow.el.offsetTop - PC_CONTEXT_ROWS * ROW_HEIGHT_PX);
  } else {
    seedWindow(pc, thumb);
  }
  updateMarkers();
}

export const disasmPaneGba: Pane = {
  id: "disasm",
  label: "Disasm",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-disasm");

    const list = document.createElement("div");
    list.className = "disasm-list";

    const toggleFromEvent = (e: Event): void => {
      const rowEl = (e.target as HTMLElement).closest<HTMLDivElement>(".disasm-row");
      if (!rowEl) return;
      const target = rowEl.dataset.target;
      if (!target) return;
      const addr = parseInt(target, 16);
      if (!Number.isFinite(addr)) return;
      e.preventDefault();
      toggleGbaPcBreakpoint(addr);
    };
    list.addEventListener("contextmenu", toggleFromEvent);
    list.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("disasm-bp")) toggleFromEvent(e);
    });

    let extending = false;
    list.addEventListener("scroll", () => {
      if (extending || !refs) return;
      const nearTop = list.scrollTop < EXTEND_THRESHOLD_PX;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < EXTEND_THRESHOLD_PX;
      if (!nearTop && !nearBottom) return;
      extending = true;
      requestAnimationFrame(() => {
        if (nearTop) extendBackward(EXTEND_LINES);
        if (nearBottom) extendForward(EXTEND_LINES);
        extending = false;
      });
    });

    container.appendChild(list);
    refs = { list, rows: [], thumb: false };
  },

  refresh(): void {
    if (!refs) return;
    const gba = state.gba;
    if (!gba) return;
    const thumb = gba.cpu.regs.tFlag;
    if (refs.rows.length === 0 || refs.thumb !== thumb) {
      seedWindow(gba.cpu.regs.r[15]! >>> 0, thumb);
    }
    updateMarkers();
  }
};
