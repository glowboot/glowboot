import { state } from "../state.js";
import { armModeName, hex8 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * GBA CPU state pane — live view of the ARM7TDMI register file and
 * the headline control signals.
 *
 * Shape mirrors `./cpu-pane.ts` (GB): build DOM once in `mount`, cache
 * each value span in `refs`, and only write textContent on refresh so
 * an unchanging frame doesn't re-layout.
 *
 * What's shown:
 *   - Registers card: r0-r15 (16 GPRs, current bank's view), CPSR,
 *     SPSR of the current mode. r13/r14 are the active-mode banked
 *     copies; r8-r12 follow the FIQ-vs-other split — both reflect
 *     whatever the engine's banking logic has live, so a screenshot
 *     of "regs while in IRQ mode" shows the IRQ-bank r13/r14.
 *   - Flags card: N Z C V (arithmetic) + I F T (control) + Mode
 *     (USR/FIQ/IRQ/SVC/ABT/UND/SYS or "???" for reserved values).
 *   - State card: HALT, IME, IE, IF, CPU load %. Direct analogues of
 *     the GB CPU pane's State card; intrWaitMask is exposed too
 *     since it gates the halt-release path differently from a plain
 *     SWI 0x02 halt.
 *
 * Engine surfaces consumed: `gba.cpu.regs.r[0..15]`, `gba.cpu.regs.cpsr`,
 * `gba.cpu.regs.spsr`, the flag getters, `gba.cpu.halted`,
 * `gba.cpu.intrWaitMask`, `gba.interrupts.ie / if_ / ime`.
 */

interface Refs {
  // 16 GPRs
  r: HTMLElement[];
  cpsr: HTMLElement;
  spsr: HTMLElement;
  // Arithmetic flags
  nf: HTMLElement;
  zf: HTMLElement;
  cf: HTMLElement;
  vf: HTMLElement;
  // Control flags
  if_: HTMLElement;
  ff: HTMLElement;
  tf: HTMLElement;
  // Mode
  mode: HTMLElement;
  // Control / IRQ state
  halted: HTMLElement;
  intrWait: HTMLElement;
  ime: HTMLElement;
  ie: HTMLElement;
  ifReg: HTMLElement;
  load: HTMLElement;
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

export const cpuPaneGba: Pane = {
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

    const rRows: HTMLElement[] = [];
    for (let i = 0; i < 16; i++) {
      // r13 / r14 / r15 get their conventional aliases alongside the
      // numeric name — matches what disassembly output uses, so the
      // labels read the same way the user thinks about them.
      const alias = i === 13 ? " (SP)" : i === 14 ? " (LR)" : i === 15 ? " (PC)" : "";
      const r = row(`r${i}${alias}`);
      regsCard.appendChild(r.row);
      rRows.push(r.value);
    }
    const cpsr = row("CPSR");
    const spsr = row("SPSR");
    regsCard.append(cpsr.row, spsr.row);

    const flagsCard = document.createElement("div");
    flagsCard.className = "cpu-card";
    const flagsHeading = document.createElement("div");
    flagsHeading.className = "cpu-card-heading";
    flagsHeading.textContent = "Flags";
    flagsCard.appendChild(flagsHeading);
    const nf = row("N", "cpu-val cpu-flag");
    const zf = row("Z", "cpu-val cpu-flag");
    const cf = row("C", "cpu-val cpu-flag");
    const vf = row("V", "cpu-val cpu-flag");
    const if_ = row("I", "cpu-val cpu-flag");
    const ff = row("F", "cpu-val cpu-flag");
    const tf = row("T", "cpu-val cpu-flag");
    const mode = row("Mode");
    for (const r of [nf, zf, cf, vf, if_, ff, tf, mode]) flagsCard.appendChild(r.row);

    const ctrlCard = document.createElement("div");
    ctrlCard.className = "cpu-card";
    const ctrlHeading = document.createElement("div");
    ctrlHeading.className = "cpu-card-heading";
    ctrlHeading.textContent = "State";
    ctrlCard.appendChild(ctrlHeading);
    const halted = row("HALT");
    const intrWait = row("IntrWait");
    const ime = row("IME");
    const ie = row("IE");
    const ifReg = row("IF");
    // CPU load — % of cycles spent executing instructions vs in HALT.
    // Mirrors the GB CPU pane's `load` row; smoothed over 250 ms by
    // the shared `tickStatus` (engine-agnostic).
    const load = row("Load");
    for (const r of [halted, intrWait, ime, ie, ifReg, load]) ctrlCard.appendChild(r.row);

    container.append(regsCard, flagsCard, ctrlCard);

    refs = {
      r: rRows,
      cpsr: cpsr.value,
      spsr: spsr.value,
      nf: nf.value,
      zf: zf.value,
      cf: cf.value,
      vf: vf.value,
      if_: if_.value,
      ff: ff.value,
      tf: tf.value,
      mode: mode.value,
      halted: halted.value,
      intrWait: intrWait.value,
      ime: ime.value,
      ie: ie.value,
      ifReg: ifReg.value,
      load: load.value
    };
  },

  refresh(): void {
    if (!refs) return;
    const gba = state.gba;
    if (!gba) {
      for (const el of refs.r) el.textContent = "—";
      return;
    }
    const regs = gba.cpu.regs;
    for (let i = 0; i < 16; i++) {
      refs.r[i]!.textContent = hex8(regs.r[i]! | 0);
    }
    refs.cpsr.textContent = hex8(regs.cpsr | 0);
    refs.spsr.textContent = hex8(regs.spsr | 0);

    setFlag(refs.nf, regs.nFlag);
    setFlag(refs.zf, regs.zFlag);
    setFlag(refs.cf, regs.cFlag);
    setFlag(refs.vf, regs.vFlag);
    setFlag(refs.if_, regs.iFlag);
    setFlag(refs.ff, regs.fFlag);
    setFlag(refs.tf, regs.tFlag);
    refs.mode.textContent = `${armModeName(regs.mode)} (${(regs.mode & 0x1f).toString(16).toUpperCase()})`;

    refs.halted.textContent = gba.cpu.halted ? "1" : "0";
    refs.intrWait.textContent = `$${(gba.cpu.intrWaitMask & 0xffff).toString(16).padStart(4, "0").toUpperCase()}`;
    refs.ime.textContent = gba.interrupts.ime & 1 ? "1" : "0";
    refs.ie.textContent = `$${(gba.interrupts.ie & 0xffff).toString(16).padStart(4, "0").toUpperCase()}`;
    refs.ifReg.textContent = `$${(gba.interrupts.if_ & 0xffff).toString(16).padStart(4, "0").toUpperCase()}`;
    refs.load.textContent = `${state.cpuLoadPct}%`;
  }
};

function setFlag(el: HTMLElement, on: boolean): void {
  el.textContent = on ? "1" : "0";
  el.classList.toggle("cpu-flag-on", on);
}
