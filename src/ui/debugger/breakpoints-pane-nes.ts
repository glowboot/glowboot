import {
  addPcBreakpoint,
  addReadWatchpoint,
  addressFor,
  addWriteWatchpoint,
  clearBreakpoints,
  listPcBreakpoints,
  listReadWatchpoints,
  listWriteWatchpoints,
  peekHit,
  removePcBreakpoint,
  removeReadWatchpoint,
  removeWriteWatchpoint,
  symbolFor
} from "../../nes";
import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { escapeHtml, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * Breakpoints pane for the NES engine — management UI for the registry
 * in `nes/debug/breakpoints.ts`. Parallel to `./breakpoints-pane.ts`
 * (GB) and `./breakpoints-pane-gba.ts`: three lists (PC / read / write)
 * plus an add-form that takes `$XXXX` / `0xXXXX` / plain hex or a symbol
 * name, and a Clear-all button. Addresses are 16-bit (the 6502 CPU bus).
 *
 * The lists are rebuilt only when their contents change — re-rendering
 * the X button on every 60 Hz rAF tick would wipe it between a user's
 * mousedown and mouseup and the browser would drop the click.
 */

interface SectionRefs {
  list: HTMLDivElement | null;
  remove: (addr: number) => void;
  onChange: () => void;
  /** Last-rendered list signature — skip the rebuild when unchanged so a
   *  60 Hz rAF refresh doesn't wipe the X button between user mousedown
   *  and mouseup (the browser drops the click if its target disappears
   *  mid-gesture). */
  lastSig: string;
}

interface Refs {
  pc: SectionRefs;
  read: SectionRefs;
  write: SectionRefs;
  addrInput: HTMLInputElement;
  kindSelect: HTMLSelectElement;
  status: HTMLSpanElement;
}

let refs: Refs | null = null;

/**
 * Accept either a hex address (`$0150`, `0x0150`, `0150`) or a symbol
 * name from the currently loaded `.sym` file. Symbol resolution is tried
 * only when the input doesn't look like hex, so numeric-only labels
 * (`0150`) still take the hex interpretation.
 */
function parseAddr(raw: string): number | null {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^\$/, "").replace(/^0x/i, "");
  if (/^[0-9a-f]{1,4}$/i.test(stripped)) {
    const n = parseInt(stripped, 16);
    if (!Number.isNaN(n) && n >= 0 && n <= 0xffff) return n;
  }
  const sym = addressFor(trimmed);
  if (sym) return sym.addr;
  return null;
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
  // Skip the rebuild when nothing changed — see SectionRefs.lastSig.
  const sig = addrs.join(",");
  if (sig === ref.lastSig) return;
  ref.lastSig = sig;
  const container = ref.list!;
  if (addrs.length === 0) {
    container.innerHTML = `<div class="bp-empty">${escapeHtml(emptyLabel)}</div>`;
    return;
  }
  container.innerHTML = "";
  for (const a of addrs) {
    const row = document.createElement("div");
    row.className = "bp-row";
    const addrSpan = document.createElement("span");
    addrSpan.className = "bp-addr";
    const sym = symbolFor(a);
    addrSpan.textContent = sym ? `${hex4(a)} ${sym}` : hex4(a);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "bp-remove";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.setAttribute("aria-label", `Remove breakpoint at ${hex4(a)}`);
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

export const breakpointsPaneNes: Pane = {
  id: "breakpoints",
  label: "Breakpoints",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-bp");

    // Status line — shows most-recent hit, if any.
    const status = document.createElement("span");
    status.className = "bp-status";
    status.textContent = "—";
    container.appendChild(status);

    // Add form.
    const form = document.createElement("form");
    form.className = "bp-add-form";
    const addrInput = document.createElement("input");
    addrInput.type = "text";
    addrInput.placeholder = "$8000";
    addrInput.maxLength = 6;
    addrInput.className = "bp-addr-input";
    const kindSelect = document.createElement("select");
    kindSelect.className = "bp-kind-select";
    for (const [value, label] of [
      ["pc", "Execute"],
      ["read", "Read"],
      ["write", "Write"]
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      kindSelect.appendChild(opt);
    }
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add";
    submit.className = "bp-add-btn";
    // Quick-add at current PC — saves the user from reading PC off the
    // CPU pane and typing it back in. Honours the kind selector so the
    // same button can drop a read / write watchpoint at PC too.
    const atPcBtn = document.createElement("button");
    atPcBtn.type = "button";
    atPcBtn.textContent = "At PC";
    atPcBtn.className = "bp-add-btn bp-add-pc-btn";
    atPcBtn.title = "Add breakpoint at current program counter";
    atPcBtn.addEventListener("click", () => {
      const pc = state.nes?.cpu.pc;
      if (pc === undefined) {
        toast("No ROM loaded");
        return;
      }
      switch (kindSelect.value) {
        case "pc":
          addPcBreakpoint(pc);
          break;
        case "read":
          addReadWatchpoint(pc);
          break;
        case "write":
          addWriteWatchpoint(pc);
          break;
      }
      breakpointsPaneNes.refresh();
    });
    form.append(addrInput, kindSelect, submit, atPcBtn);
    container.appendChild(form);

    // Three sections.
    const pcRef: SectionRefs = { list: null, remove: removePcBreakpoint, onChange: () => {}, lastSig: "\0" };
    const readRef: SectionRefs = { list: null, remove: removeReadWatchpoint, onChange: () => {}, lastSig: "\0" };
    const writeRef: SectionRefs = { list: null, remove: removeWriteWatchpoint, onChange: () => {}, lastSig: "\0" };
    const refreshNow = (): void => {
      breakpointsPaneNes.refresh();
    };
    container.append(
      buildSection("Execute (PC)", removePcBreakpoint, pcRef, refreshNow),
      buildSection("Read watchpoints", removeReadWatchpoint, readRef, refreshNow),
      buildSection("Write watchpoints", removeWriteWatchpoint, writeRef, refreshNow)
    );

    // Footer with Clear all.
    const footer = document.createElement("div");
    footer.className = "bp-footer";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear all";
    clearBtn.className = "bp-clear-btn";
    clearBtn.addEventListener("click", () => {
      clearBreakpoints();
      toast("Breakpoints cleared");
      refreshNow();
    });
    footer.appendChild(clearBtn);
    container.appendChild(footer);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const addr = parseAddr(addrInput.value);
      if (addr === null) {
        toast("Enter a hex address 0–FFFF");
        return;
      }
      switch (kindSelect.value) {
        case "pc":
          addPcBreakpoint(addr);
          break;
        case "read":
          addReadWatchpoint(addr);
          break;
        case "write":
          addWriteWatchpoint(addr);
          break;
      }
      addrInput.value = "";
      addrInput.focus();
      refreshNow();
    });

    refs = {
      pc: pcRef,
      read: readRef,
      write: writeRef,
      addrInput,
      kindSelect,
      status
    };
  },

  refresh(): void {
    if (!refs) return;
    renderList(refs.pc, listPcBreakpoints(), "no breakpoints");
    renderList(refs.read, listReadWatchpoints(), "no watchpoints");
    renderList(refs.write, listWriteWatchpoints(), "no watchpoints");
    const hit = peekHit();
    if (hit) {
      const label = hit.kind === "pc" ? "exec" : hit.kind;
      refs.status.textContent = `Last hit: ${label} @ ${hex4(hit.addr)}`;
      refs.status.classList.add("bp-status-hit");
    } else {
      refs.status.textContent = "—";
      refs.status.classList.remove("bp-status-hit");
    }
  }
};
