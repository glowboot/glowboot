import { decode, hasPcBreakpoint, symbolFor, togglePcBreakpoint } from "../../gb";
import { state } from "../state.js";
import { hex2, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * Live disassembly pane — decodes the instructions around the current
 * program counter and renders them as a scrolling list with lazy
 * extension at both edges. The row at PC is highlighted, clicking the
 * gutter or right-clicking a row toggles a breakpoint.
 *
 * Walking backwards from PC is impossible in general (variable-length
 * instructions + no back-references), so the backward-extend path uses
 * the same walk-forward-from-earlier-bytes heuristic as the initial
 * seed: reach back ~EXTEND_LINES × 3 bytes, decode forward, and keep
 * the tail that leads up to the current window's first address.
 *
 * Refresh never re-seeds — it only repaints the current-PC highlight
 * and breakpoint markers on the rows already in the window. If PC
 * jumps out of the window (e.g. a `JP` to another bank), the user
 * just loses the PC highlight until they scroll — a deliberate call
 * so the refresh loop doesn't clobber their current reading position.
 */

/** Byte budget for the context we seed BEFORE PC. At ~2 bytes/instr
 *  average this is ~8 lines of context; worst-case 3-byte instrs still
 *  yield 5+ rows above PC so `scrollDisasmToPc`'s 5-line offset has
 *  actual rows to scroll against. */
const INITIAL_LINES_BEFORE = 16;
const INITIAL_LINES_AFTER = 150;

/** Approximate disasm row height in pixels — matches `line-height: 18`
 *  set on `.disasm-row` in popovers.css. Used to convert "show N rows
 *  of context above PC" into a scrollTop pixel offset. */
const ROW_HEIGHT_PX = 18;
/** Rows of context to keep visible above PC when scrolling to it. */
const PC_CONTEXT_ROWS = 5;
/** Threshold in pixels from the top/bottom edge that triggers a new
 *  batch of decoded lines. ~200 px ≈ 11 rows at 18 px line-height, so
 *  we always extend before the user hits the actual edge. */
const EXTEND_THRESHOLD_PX = 200;
/** How many lines to append / prepend per lazy-extend batch. Smaller
 *  values make each scroll feel interactive, larger values reduce the
 *  number of extensions on a fast scroll. 80 is a compromise that
 *  keeps frame time well under one frame per batch. */
const EXTEND_LINES = 80;
/** When prepending, we have to walk forward from an earlier address
 *  and hope alignment re-syncs. This multiplier sets how many bytes
 *  earlier we start: roughly EXTEND_LINES × 3 covers the worst case
 *  (every instruction is a 3-byte LD) plus slack for alignment drift. */
const PREPEND_BYTE_BUDGET = EXTEND_LINES * 4;

/** One rendered row's DOM handles + metadata. */
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
  return { el, bp, addrEl: addr, bytesEl: bytes, mnEl: mn, opEl: op, addr: 0, length: 1 };
}

/** Decode one instruction at `addr` and write it into `row`. Pulls
 *  bytes through the MMU directly because the caller doesn't know the
 *  instruction length until after decode. */
function paintRow(row: Row, addr: number, currentBank: number): void {
  const gb = state.gb;
  if (!gb) return;
  const b0 = gb.mmu.readByte(addr);
  const b1 = gb.mmu.readByte((addr + 1) & 0xffff);
  const b2 = gb.mmu.readByte((addr + 2) & 0xffff);
  const decoded = decode(b0, b1, b2, addr);

  row.addr = addr;
  row.length = decoded.length;
  row.el.dataset.target = hex4(addr).slice(1);

  row.addrEl.textContent = hex4(addr).slice(1);
  let bytesTxt = hex2(b0).slice(1);
  if (decoded.length >= 2) bytesTxt += " " + hex2(b1).slice(1);
  if (decoded.length >= 3) bytesTxt += " " + hex2(b2).slice(1);
  row.bytesEl.textContent = bytesTxt;
  row.mnEl.textContent = decoded.mnemonic;

  let operands = decoded.operands;
  if (decoded.targetAddr !== undefined) {
    const name = symbolFor(decoded.targetAddr, currentBank);
    if (name) operands = operands.replace(hex4(decoded.targetAddr), name);
  }
  row.opEl.textContent = operands;
}

/** Build the initial window around `pc`: a few bytes earlier (so the
 *  user has context above the current instruction) and INITIAL_LINES_AFTER
 *  lines forward. Clears any existing rows first. Auto-scrolls so the
 *  PC row is visible. */
function seedWindow(pc: number): void {
  if (!refs) return;
  const gb = state.gb;
  if (!gb) return;

  refs.list.innerHTML = "";
  refs.rows = [];

  const currentBank = gb.cart.currentRomBank;
  let addr = (pc - INITIAL_LINES_BEFORE) & 0xffff;
  for (let i = 0; i < INITIAL_LINES_BEFORE + 1 + INITIAL_LINES_AFTER; i++) {
    const row = createRow();
    paintRow(row, addr, currentBank);
    refs.list.appendChild(row.el);
    refs.rows.push(row);
    addr = (addr + row.length) & 0xffff;
    // Stop if we'd wrap past $FFFF — addresses wrap in hardware but
    // the user almost never reads disasm across the wrap, and
    // stopping keeps the row-count bounded.
    if (addr < ((pc - INITIAL_LINES_BEFORE) & 0xffff) && i > INITIAL_LINES_BEFORE) break;
  }

  // Scroll so the PC row has PC_CONTEXT_ROWS of context above it.
  // Done after the DOM paints so offsetTop is meaningful.
  queueMicrotask(() => {
    if (!refs) return;
    const pcRow = refs.rows.find((r) => r.addr === pc);
    if (pcRow) refs.list.scrollTop = Math.max(0, pcRow.el.offsetTop - PC_CONTEXT_ROWS * ROW_HEIGHT_PX);
  });
}

/** Append `count` more lines past the current window's tail. No-op
 *  when the window already reaches $FFFF (can't extend past the
 *  address space end). */
function extendForward(count: number): void {
  if (!refs || refs.rows.length === 0) return;
  const gb = state.gb;
  if (!gb) return;
  const last = refs.rows[refs.rows.length - 1]!;
  let addr = (last.addr + last.length) & 0xffff;
  // If wrapping past $FFFF, stop extending — the first line we'd add
  // would be at $0000 which is unrelated to the surrounding code.
  if (addr < last.addr) return;
  const currentBank = gb.cart.currentRomBank;
  for (let i = 0; i < count; i++) {
    const row = createRow();
    paintRow(row, addr, currentBank);
    refs.list.appendChild(row.el);
    refs.rows.push(row);
    const next = (addr + row.length) & 0xffff;
    if (next < addr) break;
    addr = next;
  }
}

/** Walk forward from `startAddr`, decoding instruction-by-instruction,
 *  and return whether the walker's address sequence lands exactly on
 *  `head`. Used by `extendBackward` to pick a backstep that re-syncs
 *  with the existing window instead of leaving a gap or overlap. */
function walkReachesHead(startAddr: number, head: number): boolean {
  const gb = state.gb;
  if (!gb) return false;
  let addr = startAddr;
  // Worst-case upper bound: `PREPEND_BYTE_BUDGET` bytes of 1-byte
  // instructions. Avoids accidentally looping forever if the decoder
  // returns length 0 on malformed input.
  let safety = PREPEND_BYTE_BUDGET + 4;
  while (addr < head && safety-- > 0) {
    const b0 = gb.mmu.readByte(addr);
    const b1 = gb.mmu.readByte((addr + 1) & 0xffff);
    const b2 = gb.mmu.readByte((addr + 2) & 0xffff);
    const decoded = decode(b0, b1, b2, addr);
    const nextAddr = (addr + decoded.length) & 0xffff;
    if (nextAddr > head) return false;
    addr = nextAddr;
  }
  return addr === head;
}

/** Prepend `count` more lines before the current window's head. Uses
 *  the forward-walk-from-earlier-bytes heuristic because you can't
 *  decode backwards. Preserves scroll position so content doesn't
 *  jump under the user. */
function extendBackward(count: number): void {
  if (!refs || refs.rows.length === 0) return;
  const gb = state.gb;
  if (!gb) return;

  const head = refs.rows[0]!.addr;
  if (head === 0x0000) return; // already at the top of the address space

  const currentBank = gb.cart.currentRomBank;

  // Prefer a backstep whose forward walk lands exactly on `head` so
  // the prepended segment seams cleanly with the existing window.
  // Variable-length opcodes mean many backsteps are misaligned — the
  // walker lands on head-3 or head-1, not head itself. Trying
  // progressively later starts usually finds a clean alignment in
  // a handful of bytes. If no offset in the budget re-syncs, we
  // fall back to best-effort (overshoot-skip) so the user still
  // gets some prepended context rather than a dead-scroll.
  let syncedStart = -1;
  for (let offset = 0; offset < PREPEND_BYTE_BUDGET; offset++) {
    const candidate = Math.max(0, head - PREPEND_BYTE_BUDGET + offset);
    if (walkReachesHead(candidate, head)) {
      syncedStart = candidate;
      break;
    }
  }

  const collected: Row[] = [];
  if (syncedStart >= 0) {
    // Clean walk from a re-syncing start — every decoded row is valid
    // and the segment seams exactly with the existing head.
    let addr = syncedStart;
    while (addr < head && collected.length < count * 3) {
      const row = createRow();
      paintRow(row, addr, currentBank);
      collected.push(row);
      addr = (addr + row.length) & 0xffff;
    }
  } else {
    // Fallback: walk from the earliest candidate, skipping bytes when
    // the decoder would overshoot `head`. This may leave a 1-3 byte
    // gap at the seam (alignment never re-synced) but keeps the
    // prepend useful — user sees context, just with a tiny stutter at
    // the boundary.
    let addr = Math.max(0, head - PREPEND_BYTE_BUDGET);
    while (addr < head && collected.length < count * 3) {
      const row = createRow();
      paintRow(row, addr, currentBank);
      const nextAddr = (addr + row.length) & 0xffff;
      if (nextAddr > head) {
        addr++;
        continue;
      }
      collected.push(row);
      addr = nextAddr;
    }
  }

  // Only keep the tail — the most recent `count` rows that lead up to
  // the existing window. Rows before that are stale "context-of-context"
  // that the user didn't ask for.
  const tail = collected.slice(-count);
  if (tail.length === 0) return;

  // Measure scroll offset before DOM surgery; we'll restore it after
  // prepending so the user's view point doesn't leap.
  const scrollBefore = refs.list.scrollTop;
  const firstRowEl = refs.rows[0]!.el;
  // Iterate forward so the tail lands in increasing-address order
  // above the existing rows. Iterating backward would flip the
  // prepended segment (high addr at top, low addr just above oldFirst),
  // which is how scrolling down started showing decreasing addresses.
  for (let i = 0; i < tail.length; i++) {
    refs.list.insertBefore(tail[i]!.el, firstRowEl);
  }
  refs.rows = [...tail, ...refs.rows];
  // Added content height = sum of row heights. Measure via offsetTop
  // delta of the old first row.
  const newFirstRowEl = refs.rows[0]!.el;
  const addedHeight = firstRowEl.offsetTop - newFirstRowEl.offsetTop;
  refs.list.scrollTop = scrollBefore + addedHeight;
}

/** Repaint the current-PC highlight + breakpoint dots on every row
 *  currently in the window. Cheap — no decode work, just class
 *  toggles and text content writes on ~200 rows. */
function updateMarkers(): void {
  if (!refs) return;
  const gb = state.gb;
  const pc = gb?.cpu.regs.pc;
  for (const row of refs.rows) {
    const isCurrent = pc !== undefined && row.addr === pc;
    row.el.classList.toggle("disasm-row-current", isCurrent);
    const hasBp = hasPcBreakpoint(row.addr);
    row.el.classList.toggle("disasm-row-bp", hasBp);
    row.bp.textContent = hasBp ? "●" : "";
  }
}

/** Scroll the list so the current PC row is visible. If PC is inside
 *  the current window, scrolls to it. If PC is outside the window
 *  (big jump / bank switch / pane was seeded far away), re-seeds the
 *  window around PC. Called by the debugger's control-bar buttons so
 *  stepping always brings the user back to PC. */
export function scrollDisasmToPc(): void {
  if (!refs) return;
  const gb = state.gb;
  if (!gb) return;
  const pc = gb.cpu.regs.pc;
  const pcRow = refs.rows.find((r) => r.addr === pc);
  if (pcRow) {
    // Already in window — scroll so PC sits below PC_CONTEXT_ROWS of
    // surrounding code, not flush against the top edge.
    refs.list.scrollTop = Math.max(0, pcRow.el.offsetTop - PC_CONTEXT_ROWS * ROW_HEIGHT_PX);
  } else {
    // PC isn't in our window — re-seed. This wipes the accumulated
    // scrollback, which is the right trade-off: the user asked to
    // step, which implies they want to see PC.
    seedWindow(pc);
  }
  updateMarkers();
}

export const disasmPane: Pane = {
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
      togglePcBreakpoint(addr);
    };
    list.addEventListener("contextmenu", toggleFromEvent);
    list.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("disasm-bp")) toggleFromEvent(e);
    });

    // Lazy-extend on scroll. Rate-limit via a scheduled flag so a
    // momentum-scroll stream doesn't queue hundreds of extensions.
    let extending = false;
    list.addEventListener("scroll", () => {
      if (extending || !refs) return;
      const nearTop = list.scrollTop < EXTEND_THRESHOLD_PX;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < EXTEND_THRESHOLD_PX;
      if (!nearTop && !nearBottom) return;
      extending = true;
      // Defer to next frame so the browser's current scroll settles
      // before we mutate the DOM under it.
      requestAnimationFrame(() => {
        if (nearTop) extendBackward(EXTEND_LINES);
        if (nearBottom) extendForward(EXTEND_LINES);
        extending = false;
      });
    });

    container.appendChild(list);
    refs = { list, rows: [] };
  },

  refresh(): void {
    if (!refs) return;
    const gb = state.gb;
    if (!gb) return;
    // First paint seeds the window around PC. After that, refresh only
    // repaints markers — extending the window is the scroll handler's
    // job. This lets the user scroll away from PC without the refresh
    // loop yanking them back.
    if (refs.rows.length === 0) {
      seedWindow(gb.cpu.regs.pc);
    }
    updateMarkers();
  }
};
