import { state } from "../state.js";
import { hex2, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * SNES CPU pane — live view of the 65C816 register file plus the
 * SPC700 sound CPU.
 *
 * Shape mirrors `./cpu-pane-gba.ts`: build DOM once in `mount`, cache
 * each value span in `refs`, and only write textContent on refresh so
 * an unchanging frame doesn't re-layout.
 *
 * What's shown:
 *   - Registers card: A X Y S D (16-bit), DBR PBR (8-bit banks), PC,
 *     and the emulation-mode bit E.
 *   - Flags card: the P register bits N V M X D I Z C. In emulation
 *     mode (E=1) the M/X positions carry their 6502-style meanings;
 *     the raw bits are shown either way.
 *   - State card: STP, WAI, master-cycle counter, CPU load %.
 *   - SPC700 card: the sound CPU's A X Y SP PC PSW plus its
 *     STOP / SLEEP latches.
 */

interface Refs {
  a: HTMLElement;
  x: HTMLElement;
  y: HTMLElement;
  s: HTMLElement;
  d: HTMLElement;
  dbr: HTMLElement;
  pbr: HTMLElement;
  pc: HTMLElement;
  e: HTMLElement;
  fN: HTMLElement;
  fV: HTMLElement;
  fM: HTMLElement;
  fX: HTMLElement;
  fD: HTMLElement;
  fI: HTMLElement;
  fZ: HTMLElement;
  fC: HTMLElement;
  stp: HTMLElement;
  wai: HTMLElement;
  cycles: HTMLElement;
  load: HTMLElement;
  spcA: HTMLElement;
  spcX: HTMLElement;
  spcY: HTMLElement;
  spcSp: HTMLElement;
  spcPc: HTMLElement;
  spcPsw: HTMLElement;
  spcStop: HTMLElement;
  spcSleep: HTMLElement;
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

function card(heading: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "cpu-card";
  const h = document.createElement("div");
  h.className = "cpu-card-heading";
  h.textContent = heading;
  el.appendChild(h);
  return el;
}

export const cpuPaneSnes: Pane = {
  id: "cpu",
  label: "CPU",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-cpu");

    const regsCard = card("Registers");
    const a = row("A");
    const x = row("X");
    const y = row("Y");
    const s = row("S");
    const d = row("D");
    const dbr = row("DBR");
    const pbr = row("PBR");
    const pc = row("PC");
    const e = row("E");
    for (const r of [a, x, y, s, d, dbr, pbr, pc, e]) regsCard.appendChild(r.row);

    const flagsCard = card("Flags");
    const fN = row("N", "cpu-val cpu-flag");
    const fV = row("V", "cpu-val cpu-flag");
    const fM = row("M", "cpu-val cpu-flag");
    const fX = row("X", "cpu-val cpu-flag");
    const fD = row("D", "cpu-val cpu-flag");
    const fI = row("I", "cpu-val cpu-flag");
    const fZ = row("Z", "cpu-val cpu-flag");
    const fC = row("C", "cpu-val cpu-flag");
    for (const r of [fN, fV, fM, fX, fD, fI, fZ, fC]) flagsCard.appendChild(r.row);

    const stateCard = card("State");
    const stp = row("STP");
    const wai = row("WAI");
    const cycles = row("Cycles");
    const load = row("Load");
    for (const r of [stp, wai, cycles, load]) stateCard.appendChild(r.row);

    const spcCard = card("SPC700");
    const spcA = row("A");
    const spcX = row("X");
    const spcY = row("Y");
    const spcSp = row("SP");
    const spcPc = row("PC");
    const spcPsw = row("PSW");
    const spcStop = row("STOP", "cpu-val cpu-flag");
    const spcSleep = row("SLEEP", "cpu-val cpu-flag");
    for (const r of [spcA, spcX, spcY, spcSp, spcPc, spcPsw, spcStop, spcSleep]) spcCard.appendChild(r.row);

    container.append(regsCard, flagsCard, stateCard, spcCard);

    refs = {
      a: a.value,
      x: x.value,
      y: y.value,
      s: s.value,
      d: d.value,
      dbr: dbr.value,
      pbr: pbr.value,
      pc: pc.value,
      e: e.value,
      fN: fN.value,
      fV: fV.value,
      fM: fM.value,
      fX: fX.value,
      fD: fD.value,
      fI: fI.value,
      fZ: fZ.value,
      fC: fC.value,
      stp: stp.value,
      wai: wai.value,
      cycles: cycles.value,
      load: load.value,
      spcA: spcA.value,
      spcX: spcX.value,
      spcY: spcY.value,
      spcSp: spcSp.value,
      spcPc: spcPc.value,
      spcPsw: spcPsw.value,
      spcStop: spcStop.value,
      spcSleep: spcSleep.value
    };
  },

  refresh(): void {
    if (!refs) return;
    const snes = state.snes;
    if (!snes) return;
    const cpu = snes.cpu;

    refs.a.textContent = hex4(cpu.a);
    refs.x.textContent = hex4(cpu.x);
    refs.y.textContent = hex4(cpu.y);
    refs.s.textContent = hex4(cpu.s);
    refs.d.textContent = hex4(cpu.d);
    refs.dbr.textContent = hex2(cpu.dbr);
    refs.pbr.textContent = hex2(cpu.pbr);
    refs.pc.textContent = hex4(cpu.pc);
    refs.e.textContent = cpu.e ? "1 (emulation)" : "0 (native)";

    setFlag(refs.fN, (cpu.p & 0x80) !== 0);
    setFlag(refs.fV, (cpu.p & 0x40) !== 0);
    setFlag(refs.fM, (cpu.p & 0x20) !== 0);
    setFlag(refs.fX, (cpu.p & 0x10) !== 0);
    setFlag(refs.fD, (cpu.p & 0x08) !== 0);
    setFlag(refs.fI, (cpu.p & 0x04) !== 0);
    setFlag(refs.fZ, (cpu.p & 0x02) !== 0);
    setFlag(refs.fC, (cpu.p & 0x01) !== 0);

    refs.stp.textContent = cpu.stopped ? "1" : "0";
    refs.wai.textContent = cpu.waiting ? "1" : "0";
    refs.cycles.textContent = String(Math.floor(cpu.cycles));
    refs.load.textContent = `${state.cpuLoadPct}%`;

    const spc = snes.apu.cpu;
    refs.spcA.textContent = hex2(spc.a);
    refs.spcX.textContent = hex2(spc.x);
    refs.spcY.textContent = hex2(spc.y);
    refs.spcSp.textContent = hex2(spc.sp);
    refs.spcPc.textContent = hex4(spc.pc);
    refs.spcPsw.textContent = hex2(spc.psw);
    setFlag(refs.spcStop, spc.stopped);
    setFlag(refs.spcSleep, spc.sleeping);
  }
};

function setFlag(el: HTMLElement, on: boolean): void {
  el.textContent = on ? "1" : "0";
  el.classList.toggle("cpu-flag-on", on);
}
