import type { Snes } from "../../snes";
import { state } from "../state.js";
import { disassemble65c816 } from "./disasm-65c816.js";
import { hex2, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * SNES live-disassembly pane. Parallel to `./disasm-pane-gba.ts`, with
 * 65C816-specific differences:
 *
 *   - **Variable instruction size, flag-dependent.** Lengths run 1-4
 *     bytes and immediate widths depend on the live M/X flags, so the
 *     GBA pane's step-back-N×instrSize backward extension can't work
 *     and even the walk-forward-from-earlier-bytes re-sync heuristic
 *     is unreliable (the flags at earlier addresses are unknown). The
 *     window therefore starts AT the current PC and only extends
 *     forward.
 *   - **Width follow.** The whole window is decoded with the widths in
 *     effect at the live PC; a REP/SEP that changes them re-seeds so
 *     the user doesn't read stale lengths.
 *   - **No breakpoints yet.** The SNES engine has no PC-breakpoint API,
 *     so rows carry the gutter column for layout but no toggle.
 */

const INITIAL_LINES = 167;
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
  m8: boolean;
  x8: boolean;
}

let refs: Refs | null = null;

/** Side-effect-free bus read for the disassembly view. `bus.read` updates
 *  the open-bus data register and MMIO reads can have hardware side
 *  effects, so this resolves WRAM and cart ROM directly (same LoROM/HiROM
 *  math as the bus) and returns 0 for everything else. */
function peek(snes: Snes, addr: number): number {
  const bank = (addr >> 16) & 0xff;
  const off = addr & 0xffff;
  if (bank === 0x7e || bank === 0x7f) return snes.bus.wram[((bank - 0x7e) << 16) | off]!;
  const sysBank = bank & 0x7f;
  if (sysBank <= 0x3f && off < 0x2000) return snes.bus.wram[off]!;
  if (off >= 0x8000 || sysBank >= 0x40) {
    const rom = snes.rom.rom;
    const index =
      snes.rom.mapping === "lorom"
        ? sysBank * 0x8000 + (off & 0x7fff)
        : sysBank >= 0x40
          ? ((sysBank - 0x40) << 16) | off
          : (sysBank << 16) | off;
    return rom[index % rom.length]!;
  }
  return 0;
}

function cpuM8(snes: Snes): boolean {
  return snes.cpu.e === 1 || (snes.cpu.p & 0x20) !== 0;
}

function cpuX8(snes: Snes): boolean {
  return snes.cpu.e === 1 || (snes.cpu.p & 0x10) !== 0;
}

function createRow(): Row {
  const el = document.createElement("div");
  el.className = "disasm-row";
  const bp = document.createElement("span");
  bp.className = "disasm-bp";
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

function paintRow(row: Row, snes: Snes, addr: number, m8: boolean, x8: boolean): void {
  const pbr = (addr >> 16) & 0xff;
  const pc = addr & 0xffff;
  const d = disassemble65c816((a) => peek(snes, a), pbr, pc, m8, x8);
  row.addr = addr;
  row.length = d.length;
  row.addrEl.textContent = `${hex2(pbr).slice(1)}:${hex4(pc).slice(1)}`;
  let bytesTxt = "";
  for (let i = 0; i < d.length; i++) {
    const b = peek(snes, (pbr << 16) | ((pc + i) & 0xffff));
    bytesTxt += (i > 0 ? " " : "") + hex2(b).slice(1);
  }
  row.bytesEl.textContent = bytesTxt;
  const space = d.text.indexOf(" ");
  row.mnEl.textContent = space < 0 ? d.text : d.text.slice(0, space);
  row.opEl.textContent = space < 0 ? "" : d.text.slice(space + 1);
}

function seedWindow(addr: number, m8: boolean, x8: boolean): void {
  if (!refs) return;
  const snes = state.snes;
  if (!snes) return;
  refs.list.innerHTML = "";
  refs.rows = [];
  refs.m8 = m8;
  refs.x8 = x8;
  const pbr = addr & 0xff0000;
  let pc = addr & 0xffff;
  for (let i = 0; i < INITIAL_LINES; i++) {
    const row = createRow();
    paintRow(row, snes, pbr | pc, m8, x8);
    refs.list.appendChild(row.el);
    refs.rows.push(row);
    const next = (pc + row.length) & 0xffff;
    if (next < pc) break; // don't decode across the bank wrap
    pc = next;
  }
  queueMicrotask(() => {
    if (refs) refs.list.scrollTop = 0;
  });
}

function extendForward(count: number): void {
  if (!refs || refs.rows.length === 0) return;
  const snes = state.snes;
  if (!snes) return;
  const last = refs.rows[refs.rows.length - 1]!;
  const pbr = last.addr & 0xff0000;
  let pc = ((last.addr & 0xffff) + last.length) & 0xffff;
  if (pc < (last.addr & 0xffff)) return;
  for (let i = 0; i < count; i++) {
    const row = createRow();
    paintRow(row, snes, pbr | pc, refs.m8, refs.x8);
    refs.list.appendChild(row.el);
    refs.rows.push(row);
    const next = (pc + row.length) & 0xffff;
    if (next < pc) break;
    pc = next;
  }
}

function updateMarkers(): void {
  if (!refs) return;
  const snes = state.snes;
  if (!snes) return;
  const cur = (snes.cpu.pbr << 16) | snes.cpu.pc;
  for (const row of refs.rows) {
    row.el.classList.toggle("disasm-row-current", row.addr === cur);
  }
}

/** Scroll the list so the current PC row is visible. Re-seeds when PC
 *  left the window or the M/X widths changed since the last seed.
 *  Called by the orchestrator's Step / Continue controls. */
export function scrollSnesDisasmToPc(): void {
  if (!refs) return;
  const snes = state.snes;
  if (!snes) return;
  const cur = (snes.cpu.pbr << 16) | snes.cpu.pc;
  const m8 = cpuM8(snes);
  const x8 = cpuX8(snes);
  if (m8 !== refs.m8 || x8 !== refs.x8) {
    seedWindow(cur, m8, x8);
    return;
  }
  const pcRow = refs.rows.find((r) => r.addr === cur);
  if (pcRow) {
    refs.list.scrollTop = Math.max(0, pcRow.el.offsetTop - PC_CONTEXT_ROWS * ROW_HEIGHT_PX);
  } else {
    seedWindow(cur, m8, x8);
  }
  updateMarkers();
}

export const disasmPaneSnes: Pane = {
  id: "disasm",
  label: "Disasm",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-disasm");

    const list = document.createElement("div");
    list.className = "disasm-list";

    let extending = false;
    list.addEventListener("scroll", () => {
      if (extending || !refs) return;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < EXTEND_THRESHOLD_PX;
      if (!nearBottom) return;
      extending = true;
      requestAnimationFrame(() => {
        extendForward(EXTEND_LINES);
        extending = false;
      });
    });

    container.appendChild(list);
    refs = { list, rows: [], m8: true, x8: true };
  },

  refresh(): void {
    if (!refs) return;
    const snes = state.snes;
    if (!snes) return;
    const m8 = cpuM8(snes);
    const x8 = cpuX8(snes);
    if (refs.rows.length === 0 || refs.m8 !== m8 || refs.x8 !== x8) {
      seedWindow((snes.cpu.pbr << 16) | snes.cpu.pc, m8, x8);
    }
    updateMarkers();
  }
};
