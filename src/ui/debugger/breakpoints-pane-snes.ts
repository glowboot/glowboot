import {
  addSnesPcBreakpoint,
  clearAllSnesBreakpoints,
  listSnesPcBreakpoints,
  peekSnesHit,
  removeSnesPcBreakpoint
} from "../../snes";
import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { hex6 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * SNES breakpoints pane. Parallel to `./breakpoints-pane-gba.ts`; the
 * differences from the GBA version are:
 *
 *   - Addresses are 24-bit bank:offset pairs, entered as up to 6 hex
 *     digits with an optional `:` between bank and offset
 *     (`$80:8000` / `808000`) and shown as `$BB:AAAA`.
 *   - Execute (PC) breakpoints only — the SNES bus has no read/write
 *     watchpoint taps yet, so there is no kind selector.
 *   - "At PC" reads `(pbr << 16) | pc`.
 *
 * The engine-side registry (`src/snes/debug/breakpoints.ts`) handles
 * the firing logic; this pane only reads / writes it.
 */

interface Refs {
  pc: SectionRefs;
  addrInput: HTMLInputElement;
  status: HTMLSpanElement;
}

let refs: Refs | null = null;

function parseAddr(raw: string): number | null {
  const stripped = raw.trim().replace(/^\$/, "").replace(/^0x/i, "").replace(":", "");
  if (!/^[0-9a-f]{1,6}$/i.test(stripped)) return null;
  const n = parseInt(stripped, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffff) return null;
  return n & 0xffffff;
}

interface SectionRefs {
  list: HTMLDivElement | null;
  remove: (addr: number) => void;
  onChange: () => void;
  /** Last-rendered address list serialised — lets us skip the
   *  full DOM rebuild when nothing changed. Re-rendering on every
   *  rAF tick at 60 Hz wipes the X button between a user's
   *  mousedown and mouseup, killing the click event entirely. */
  lastSig: string;
}

function buildSection(
  title: string,
  remove: (addr: number) => void,
  ref: SectionRefs,
  onChange: () => void
): HTMLElement {
  const section = document.createElement("div");
  section.className = "bp-section";
  const h = document.createElement("h4");
  h.className = "bp-section-title";
  h.textContent = title;
  const list = document.createElement("div");
  list.className = "bp-list";
  ref.list = list;
  ref.remove = remove;
  ref.onChange = onChange;
  section.append(h, list);
  return section;
}

function renderList(ref: SectionRefs, addrs: number[], emptyLabel: string): void {
  // Skip the rebuild when the list hasn't changed — the rAF refresh
  // loop fires at 60 Hz; without this guard the X button is recreated
  // between every user mousedown and mouseup, which the browser sees
  // as the click target disappearing and silently drops the click.
  const sig = addrs.join(",");
  if (sig === ref.lastSig) return;
  ref.lastSig = sig;
  const container = ref.list!;
  if (addrs.length === 0) {
    container.innerHTML = `<div class="bp-empty">${emptyLabel}</div>`;
    return;
  }
  container.innerHTML = "";
  for (const a of addrs) {
    const row = document.createElement("div");
    row.className = "bp-row";
    const addrSpan = document.createElement("span");
    addrSpan.className = "bp-addr";
    addrSpan.textContent = hex6(a);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "bp-remove";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.setAttribute("aria-label", `Remove breakpoint at ${hex6(a)}`);
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ref.remove(a);
      ref.onChange();
    });
    row.append(addrSpan, rm);
    container.appendChild(row);
  }
}

export const breakpointsPaneSnes: Pane = {
  id: "breakpoints",
  label: "Breakpoints",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-bp");

    const status = document.createElement("span");
    status.className = "bp-status";
    status.textContent = "—";
    container.appendChild(status);

    const form = document.createElement("form");
    form.className = "bp-add-form";
    const addrInput = document.createElement("input");
    addrInput.type = "text";
    addrInput.placeholder = "$80:8000";
    addrInput.maxLength = 10;
    addrInput.className = "bp-addr-input";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add";
    submit.className = "bp-add-btn";
    const atPcBtn = document.createElement("button");
    atPcBtn.type = "button";
    atPcBtn.textContent = "At PC";
    atPcBtn.className = "bp-add-btn bp-add-pc-btn";
    atPcBtn.title = "Add breakpoint at current program counter (PBR:PC)";
    atPcBtn.addEventListener("click", () => {
      const cpu = state.snes?.cpu;
      if (!cpu) {
        toast("No ROM loaded");
        return;
      }
      addSnesPcBreakpoint((cpu.pbr << 16) | cpu.pc);
      // The list refresh is wired below — use it for tactile feedback
      // rather than depending on the rAF refresh tick.
      breakpointsPaneSnes.refresh();
    });
    form.append(addrInput, submit, atPcBtn);
    container.appendChild(form);

    const pcRef: SectionRefs = { list: null, remove: removeSnesPcBreakpoint, onChange: () => {}, lastSig: "\0" };
    const refreshNow = (): void => {
      breakpointsPaneSnes.refresh();
    };
    container.append(buildSection("Execute (PC)", removeSnesPcBreakpoint, pcRef, refreshNow));

    const footer = document.createElement("div");
    footer.className = "bp-footer";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear all";
    clearBtn.className = "bp-clear-btn";
    clearBtn.addEventListener("click", () => {
      clearAllSnesBreakpoints();
      toast("Breakpoints cleared");
      refreshNow();
    });
    footer.appendChild(clearBtn);
    container.appendChild(footer);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const addr = parseAddr(addrInput.value);
      if (addr === null) {
        toast("Enter a hex address 0–FFFFFF (bank:offset ok)");
        return;
      }
      addSnesPcBreakpoint(addr);
      addrInput.value = "";
      addrInput.focus();
      refreshNow();
    });

    refs = {
      pc: pcRef,
      addrInput,
      status
    };
  },

  refresh(): void {
    if (!refs) return;
    renderList(refs.pc, listSnesPcBreakpoints(), "no breakpoints");
    const hit = peekSnesHit();
    if (hit) {
      refs.status.textContent = `Last hit: exec @ ${hex6(hit.addr)}`;
      refs.status.classList.add("bp-status-hit");
    } else {
      refs.status.textContent = "—";
      refs.status.classList.remove("bp-status-hit");
    }
  }
};
