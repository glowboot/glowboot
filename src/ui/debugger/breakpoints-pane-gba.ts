import {
  addGbaPcBreakpoint,
  addGbaReadWatchpoint,
  addGbaWriteWatchpoint,
  clearAllGbaBreakpoints,
  listGbaPcBreakpoints,
  listGbaReadWatchpoints,
  listGbaWriteWatchpoints,
  peekGbaHit,
  removeGbaPcBreakpoint,
  removeGbaReadWatchpoint,
  removeGbaWriteWatchpoint
} from "../../gba";
import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { hex8 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * GBA breakpoints pane. Parallel to `./breakpoints-pane.ts`; the
 * differences from the GB version are:
 *
 *   - Addresses are 32-bit (`$XXXXXXXX`), parsed up to 8 hex digits.
 *   - No symbol resolution yet — Phase 4d will add a GBA symbols pane;
 *     until then, the address-input accepts hex only.
 *   - "At PC" reads r15 instead of regs.pc.
 *
 * Otherwise the structure is identical: three lists (PC / read /
 * write) plus an add form and a Clear-all button. The engine-side
 * registry (`src/gba/debug/breakpoints.ts`) handles the firing logic;
 * this pane only reads / writes it.
 */

interface Refs {
  pc: SectionRefs;
  read: SectionRefs;
  write: SectionRefs;
  addrInput: HTMLInputElement;
  kindSelect: HTMLSelectElement;
  status: HTMLSpanElement;
}

let refs: Refs | null = null;

function parseAddr(raw: string): number | null {
  const stripped = raw.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,8}$/i.test(stripped)) return null;
  const n = parseInt(stripped, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  return n >>> 0;
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
    addrSpan.textContent = hex8(a);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "bp-remove";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.setAttribute("aria-label", `Remove breakpoint at ${hex8(a)}`);
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

export const breakpointsPaneGba: Pane = {
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
    addrInput.placeholder = "$08000000";
    addrInput.maxLength = 10;
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
    const atPcBtn = document.createElement("button");
    atPcBtn.type = "button";
    atPcBtn.textContent = "At PC";
    atPcBtn.className = "bp-add-btn bp-add-pc-btn";
    atPcBtn.title = "Add breakpoint at current program counter (r15)";
    atPcBtn.addEventListener("click", () => {
      const pc = state.gba?.cpu.regs.r[15];
      if (pc === undefined) {
        toast("No ROM loaded");
        return;
      }
      const a = pc >>> 0;
      switch (kindSelect.value) {
        case "pc":
          addGbaPcBreakpoint(a);
          break;
        case "read":
          addGbaReadWatchpoint(a);
          break;
        case "write":
          addGbaWriteWatchpoint(a);
          break;
      }
      // The pc/read/write refresh is wired below — use it for tactile
      // feedback rather than depending on the rAF refresh tick.
      breakpointsPaneGba.refresh();
    });
    form.append(addrInput, kindSelect, submit, atPcBtn);
    container.appendChild(form);

    const pcRef: SectionRefs = { list: null, remove: removeGbaPcBreakpoint, onChange: () => {}, lastSig: "\0" };
    const readRef: SectionRefs = { list: null, remove: removeGbaReadWatchpoint, onChange: () => {}, lastSig: "\0" };
    const writeRef: SectionRefs = { list: null, remove: removeGbaWriteWatchpoint, onChange: () => {}, lastSig: "\0" };
    const refreshNow = (): void => {
      breakpointsPaneGba.refresh();
    };
    container.append(
      buildSection("Execute (PC)", removeGbaPcBreakpoint, pcRef, refreshNow),
      buildSection("Read watchpoints", removeGbaReadWatchpoint, readRef, refreshNow),
      buildSection("Write watchpoints", removeGbaWriteWatchpoint, writeRef, refreshNow)
    );

    const footer = document.createElement("div");
    footer.className = "bp-footer";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear all";
    clearBtn.className = "bp-clear-btn";
    clearBtn.addEventListener("click", () => {
      clearAllGbaBreakpoints();
      toast("Breakpoints cleared");
      refreshNow();
    });
    footer.appendChild(clearBtn);
    container.appendChild(footer);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const addr = parseAddr(addrInput.value);
      if (addr === null) {
        toast("Enter a hex address 0–FFFFFFFF");
        return;
      }
      switch (kindSelect.value) {
        case "pc":
          addGbaPcBreakpoint(addr);
          break;
        case "read":
          addGbaReadWatchpoint(addr);
          break;
        case "write":
          addGbaWriteWatchpoint(addr);
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
    renderList(refs.pc, listGbaPcBreakpoints(), "no breakpoints");
    renderList(refs.read, listGbaReadWatchpoints(), "no watchpoints");
    renderList(refs.write, listGbaWriteWatchpoints(), "no watchpoints");
    const hit = peekGbaHit();
    if (hit) {
      const label = hit.kind === "pc" ? "exec" : hit.kind;
      refs.status.textContent = `Last hit: ${label} @ ${hex8(hit.addr)}`;
      refs.status.classList.add("bp-status-hit");
    } else {
      refs.status.textContent = "—";
      refs.status.classList.remove("bp-status-hit");
    }
  }
};
