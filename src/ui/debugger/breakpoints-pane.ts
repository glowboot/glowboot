import {
  addPcBreakpoint,
  addReadWatchpoint,
  addressFor,
  addWriteWatchpoint,
  clearAll,
  listPcBreakpoints,
  listReadWatchpoints,
  listWriteWatchpoints,
  peekHit,
  removePcBreakpoint,
  removeReadWatchpoint,
  removeWriteWatchpoint,
  symbolFor
} from "../../gb";
import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * Breakpoints pane — management UI for the registry in
 * `gb/debug/breakpoints.ts`. Three lists (PC / read / write) plus
 * an add-form that takes `$XXXX` or plain hex and a kind selector.
 *
 * The lists are rebuilt on every `refresh` rather than diff-patched —
 * breakpoint counts are small (dozens at most) and Set iteration order
 * is insertion order so we'd have to rebuild either way to keep the
 * display sorted. Clicking the × removes a single entry; the "Clear
 * all" button wipes the registry.
 *
 * No inline edit of an existing entry — that's just remove + re-add.
 */

interface Refs {
  pcList: HTMLDivElement;
  readList: HTMLDivElement;
  writeList: HTMLDivElement;
  addrInput: HTMLInputElement;
  kindSelect: HTMLSelectElement;
  status: HTMLSpanElement;
}

let refs: Refs | null = null;

/**
 * Accept either a hex address (`$0150`, `0x0150`, `0150`) or a symbol
 * name from the currently loaded `.sym` file. Symbol resolution is
 * tried only when the input doesn't look like hex, so numeric-only
 * labels (`0150`) still take the hex interpretation.
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
  listRef: { list: HTMLDivElement | null }
): HTMLElement {
  const section = document.createElement("div");
  section.className = "bp-section";
  const h = document.createElement("h4");
  h.className = "bp-section-title";
  h.textContent = title;
  const list = document.createElement("div");
  list.className = "bp-list";
  listRef.list = list;
  section.append(h, list);
  list.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button.bp-remove");
    if (!btn) return;
    const addr = Number(btn.dataset.addr);
    if (!Number.isFinite(addr)) return;
    remove(addr);
  });
  return section;
}

function renderList(container: HTMLDivElement, addrs: number[], emptyLabel: string): void {
  if (addrs.length === 0) {
    container.innerHTML = `<div class="bp-empty">${emptyLabel}</div>`;
    return;
  }
  const bank = state.gb?.cart.currentRomBank ?? 0;
  container.innerHTML = "";
  for (const a of addrs) {
    const row = document.createElement("div");
    row.className = "bp-row";
    const addrSpan = document.createElement("span");
    addrSpan.className = "bp-addr";
    const sym = symbolFor(a, bank);
    addrSpan.textContent = sym ? `${hex4(a)} ${sym}` : hex4(a);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "bp-remove";
    rm.dataset.addr = String(a);
    rm.textContent = "×";
    rm.title = "Remove";
    rm.setAttribute("aria-label", `Remove breakpoint at ${hex4(a)}`);
    row.append(addrSpan, rm);
    container.appendChild(row);
  }
}

export const breakpointsPane: Pane = {
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
    addrInput.placeholder = "$0100";
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
      const pc = state.gb?.cpu.regs.pc;
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
    });
    form.append(addrInput, kindSelect, submit, atPcBtn);
    container.appendChild(form);

    // Three sections.
    const pcRef: { list: HTMLDivElement | null } = { list: null };
    const readRef: { list: HTMLDivElement | null } = { list: null };
    const writeRef: { list: HTMLDivElement | null } = { list: null };
    container.append(
      buildSection("Execute (PC)", removePcBreakpoint, pcRef),
      buildSection("Read watchpoints", removeReadWatchpoint, readRef),
      buildSection("Write watchpoints", removeWriteWatchpoint, writeRef)
    );

    // Footer with Clear all.
    const footer = document.createElement("div");
    footer.className = "bp-footer";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear all";
    clearBtn.className = "bp-clear-btn";
    clearBtn.addEventListener("click", () => {
      clearAll();
      toast("Breakpoints cleared");
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
    });

    refs = {
      pcList: pcRef.list!,
      readList: readRef.list!,
      writeList: writeRef.list!,
      addrInput,
      kindSelect,
      status
    };
  },

  refresh(): void {
    if (!refs) return;
    renderList(refs.pcList, listPcBreakpoints(), "no breakpoints");
    renderList(refs.readList, listReadWatchpoints(), "no watchpoints");
    renderList(refs.writeList, listWriteWatchpoints(), "no watchpoints");
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
