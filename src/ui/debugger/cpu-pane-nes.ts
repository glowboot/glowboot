import { state } from "../state.js";
import { hex2, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * NES CPU state pane — live view of the Ricoh 2A03 (6502) register file
 * and the PPU timing/control state.
 *
 * Shape mirrors `./cpu-pane.ts` (GB) and `./cpu-pane-gba.ts`: build the
 * DOM once in `mount`, cache each value span in `refs`, and only write
 * textContent on refresh so an unchanging frame doesn't re-layout.
 *
 * What's shown:
 *   - Registers card: A / X / Y (8-bit), SP (8-bit; stack lives at
 *     $0100 + SP), PC (16-bit), and the cumulative cycle count.
 *   - Flags card: N V - B D I Z C, decoded from the packed P byte.
 *     Bit 5 (U) is unused and always reads 1; bit 3 (D, decimal) is
 *     tracked but inert on the 2A03 — both are shown for completeness.
 *   - PPU card: CTRL / MASK / STATUS (the `debugRegs` snapshot) plus the
 *     live scanline / dot / frame counters. The NES has no CPU interrupt
 *     controller, so this card takes the slot the GB pane uses for IE/IF.
 */

interface Refs {
  // 6502 registers
  a: HTMLElement;
  x: HTMLElement;
  y: HTMLElement;
  sp: HTMLElement;
  pc: HTMLElement;
  cycles: HTMLElement;
  // Flags (N V - B D I Z C)
  nf: HTMLElement;
  vf: HTMLElement;
  uf: HTMLElement;
  bf: HTMLElement;
  df: HTMLElement;
  iff: HTMLElement;
  zf: HTMLElement;
  cf: HTMLElement;
  // PPU state
  ctrl: HTMLElement;
  mask: HTMLElement;
  status: HTMLElement;
  scanline: HTMLElement;
  dot: HTMLElement;
  frame: HTMLElement;
}

let refs: Refs | null = null;

function row(label: string, valueClass = "cpu-val"): { row: HTMLDivElement; value: HTMLSpanElement } {
  const el = document.createElement("div");
  el.className = "cpu-row";
  const l = document.createElement("span");
  l.className = "cpu-lbl";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = valueClass;
  v.textContent = "—";
  el.append(l, v);
  return { row: el, value: v };
}

export const cpuPaneNes: Pane = {
  id: "cpu",
  label: "CPU",
  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-cpu");

    const regsCard = document.createElement("div");
    regsCard.className = "cpu-card";
    const regsHeading = document.createElement("div");
    regsHeading.className = "cpu-card-heading";
    regsHeading.textContent = "Registers";
    regsCard.appendChild(regsHeading);

    const a = row("A");
    const x = row("X");
    const y = row("Y");
    const sp = row("SP");
    const pc = row("PC");
    const cycles = row("Cycles");
    for (const r of [a, x, y, sp, pc, cycles]) regsCard.appendChild(r.row);

    const flagsCard = document.createElement("div");
    flagsCard.className = "cpu-card";
    const flagsHeading = document.createElement("div");
    flagsHeading.className = "cpu-card-heading";
    flagsHeading.textContent = "Flags";
    flagsCard.appendChild(flagsHeading);
    const nf = row("N", "cpu-val cpu-flag");
    const vf = row("V", "cpu-val cpu-flag");
    const uf = row("-", "cpu-val cpu-flag");
    const bf = row("B", "cpu-val cpu-flag");
    const df = row("D", "cpu-val cpu-flag");
    const iff = row("I", "cpu-val cpu-flag");
    const zf = row("Z", "cpu-val cpu-flag");
    const cf = row("C", "cpu-val cpu-flag");
    for (const r of [nf, vf, uf, bf, df, iff, zf, cf]) flagsCard.appendChild(r.row);

    const ppuCard = document.createElement("div");
    ppuCard.className = "cpu-card";
    const ppuHeading = document.createElement("div");
    ppuHeading.className = "cpu-card-heading";
    ppuHeading.textContent = "PPU";
    ppuCard.appendChild(ppuHeading);
    const ctrl = row("CTRL");
    const mask = row("MASK");
    const status = row("STATUS");
    const scanline = row("Scanline");
    const dot = row("Dot");
    const frame = row("Frame");
    for (const r of [ctrl, mask, status, scanline, dot, frame]) ppuCard.appendChild(r.row);

    container.append(regsCard, flagsCard, ppuCard);

    refs = {
      a: a.value,
      x: x.value,
      y: y.value,
      sp: sp.value,
      pc: pc.value,
      cycles: cycles.value,
      nf: nf.value,
      vf: vf.value,
      uf: uf.value,
      bf: bf.value,
      df: df.value,
      iff: iff.value,
      zf: zf.value,
      cf: cf.value,
      ctrl: ctrl.value,
      mask: mask.value,
      status: status.value,
      scanline: scanline.value,
      dot: dot.value,
      frame: frame.value
    };
  },

  refresh(): void {
    if (!refs) return;
    const nes = state.nes;
    if (!nes) {
      refs.a.textContent = "—";
      return;
    }
    const cpu = nes.cpu;
    refs.a.textContent = hex2(cpu.a);
    refs.x.textContent = hex2(cpu.x);
    refs.y.textContent = hex2(cpu.y);
    refs.sp.textContent = hex2(cpu.sp);
    refs.pc.textContent = hex4(cpu.pc);
    refs.cycles.textContent = String(cpu.cycles);

    const p = cpu.p;
    setFlag(refs.nf, (p & 0x80) !== 0);
    setFlag(refs.vf, (p & 0x40) !== 0);
    setFlag(refs.uf, (p & 0x20) !== 0);
    setFlag(refs.bf, (p & 0x10) !== 0);
    setFlag(refs.df, (p & 0x08) !== 0);
    setFlag(refs.iff, (p & 0x04) !== 0);
    setFlag(refs.zf, (p & 0x02) !== 0);
    setFlag(refs.cf, (p & 0x01) !== 0);

    const regs = nes.ppu.debugRegs;
    refs.ctrl.textContent = hex2(regs.ctrl);
    refs.mask.textContent = hex2(regs.mask);
    refs.status.textContent = hex2(regs.status);
    refs.scanline.textContent = String(nes.ppu.scanline);
    refs.dot.textContent = String(nes.ppu.dot);
    refs.frame.textContent = String(nes.ppu.frame);
  }
};

function setFlag(el: HTMLElement, on: boolean): void {
  el.textContent = on ? "1" : "0";
  el.classList.toggle("cpu-flag-on", on);
}
