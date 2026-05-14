import { state } from "../state.js";
import { hex2, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * CPU state pane — live view of every register + flag + control
 * signal on the LR35902. Rebuilds the DOM once in `mount`, then
 * `refresh` just writes into the cached field spans each tick so the
 * browser doesn't pay layout costs for an unchanging card grid.
 */

interface Refs {
  // 8-bit registers
  a: HTMLElement;
  b: HTMLElement;
  c: HTMLElement;
  d: HTMLElement;
  e: HTMLElement;
  h: HTMLElement;
  l: HTMLElement;
  f: HTMLElement;
  // 16-bit pairs
  af: HTMLElement;
  bc: HTMLElement;
  de: HTMLElement;
  hl: HTMLElement;
  sp: HTMLElement;
  pc: HTMLElement;
  // Flags (Z N H C)
  zf: HTMLElement;
  nf: HTMLElement;
  hf: HTMLElement;
  cf: HTMLElement;
  // Control signals
  ime: HTMLElement;
  halted: HTMLElement;
  stopped: HTMLElement;
  doubleSpeed: HTMLElement;
  haltBug: HTMLElement;
  load: HTMLElement;
  // Interrupt registers
  ie: HTMLElement;
  if_: HTMLElement;
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

export const cpuPane: Pane = {
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
    const b = row("B");
    const c = row("C");
    const d = row("D");
    const e = row("E");
    const h = row("H");
    const l = row("L");
    const f = row("F");
    const af = row("AF");
    const bc = row("BC");
    const de = row("DE");
    const hl = row("HL");
    const sp = row("SP");
    const pc = row("PC");
    for (const r of [a, b, c, d, e, h, l, f, af, bc, de, hl, sp, pc]) regsCard.appendChild(r.row);

    const flagsCard = document.createElement("div");
    flagsCard.className = "cpu-card";
    const flagsHeading = document.createElement("div");
    flagsHeading.className = "cpu-card-heading";
    flagsHeading.textContent = "Flags";
    flagsCard.appendChild(flagsHeading);
    const zf = row("Z", "cpu-val cpu-flag");
    const nf = row("N", "cpu-val cpu-flag");
    const hf = row("H", "cpu-val cpu-flag");
    const cf = row("C", "cpu-val cpu-flag");
    for (const r of [zf, nf, hf, cf]) flagsCard.appendChild(r.row);

    const ctrlCard = document.createElement("div");
    ctrlCard.className = "cpu-card";
    const ctrlHeading = document.createElement("div");
    ctrlHeading.className = "cpu-card-heading";
    ctrlHeading.textContent = "State";
    ctrlCard.appendChild(ctrlHeading);
    const ime = row("IME");
    const halted = row("HALT");
    const stopped = row("STOP");
    const doubleSpeed = row("2×");
    const haltBug = row("HALT bug");
    // GB CPU load — % of cycles spent executing instructions vs in
    // HALT / STOP. Smoothed over 250 ms by `tickStatus`. Useful for
    // gauging how aggressively a game polls vs. sleeps to VBlank.
    const load = row("Load");
    const ie = row("IE");
    const if_ = row("IF");
    for (const r of [ime, halted, stopped, doubleSpeed, haltBug, load, ie, if_]) ctrlCard.appendChild(r.row);

    container.append(regsCard, flagsCard, ctrlCard);

    refs = {
      a: a.value,
      b: b.value,
      c: c.value,
      d: d.value,
      e: e.value,
      h: h.value,
      l: l.value,
      f: f.value,
      af: af.value,
      bc: bc.value,
      de: de.value,
      hl: hl.value,
      sp: sp.value,
      pc: pc.value,
      zf: zf.value,
      nf: nf.value,
      hf: hf.value,
      cf: cf.value,
      ime: ime.value,
      halted: halted.value,
      stopped: stopped.value,
      doubleSpeed: doubleSpeed.value,
      haltBug: haltBug.value,
      load: load.value,
      ie: ie.value,
      if_: if_.value
    };
  },

  refresh(): void {
    if (!refs) return;
    const gb = state.gb;
    if (!gb) {
      refs.a.textContent = "—";
      return;
    }
    const r = gb.cpu.regs;
    refs.a.textContent = hex2(r.a);
    refs.b.textContent = hex2(r.b);
    refs.c.textContent = hex2(r.c);
    refs.d.textContent = hex2(r.d);
    refs.e.textContent = hex2(r.e);
    refs.h.textContent = hex2(r.h);
    refs.l.textContent = hex2(r.l);
    refs.f.textContent = hex2(r.f);
    refs.af.textContent = hex4(r.af);
    refs.bc.textContent = hex4(r.bc);
    refs.de.textContent = hex4(r.de);
    refs.hl.textContent = hex4(r.hl);
    refs.sp.textContent = hex4(r.sp);
    refs.pc.textContent = hex4(r.pc);

    setFlag(refs.zf, r.zf);
    setFlag(refs.nf, r.nf);
    setFlag(refs.hf, r.hf);
    setFlag(refs.cf, r.cf);

    refs.ime.textContent = gb.cpu.ime ? "1" : "0";
    refs.halted.textContent = gb.cpu.halted ? "1" : "0";
    refs.stopped.textContent = gb.cpu.stopped ? "1" : "0";
    refs.doubleSpeed.textContent = gb.cpu.doubleSpeed ? "1" : "0";
    // haltBug is private on CPU; surface its effect indirectly via the
    // halted flag. Dropped from the live display to avoid reading
    // through a `@ts-ignore`; re-add later via a public getter if
    // anyone needs it.
    refs.haltBug.textContent = "—";

    refs.load.textContent = `${state.cpuLoadPct}%`;

    refs.ie.textContent = hex2(gb.interrupts.ie);
    refs.if_.textContent = hex2(gb.interrupts.if);
  }
};

function setFlag(el: HTMLElement, on: boolean): void {
  el.textContent = on ? "1" : "0";
  el.classList.toggle("cpu-flag-on", on);
}
