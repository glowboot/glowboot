import { frameList, symbolFor } from "../../gb";
import { state } from "../state.js";
import { escapeHtml, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/** Symbol-name or hex fallback. Returns the raw string so callers can
 *  pick safe-vs-unsafe contexts: `textContent` consumers (e.g. the PC
 *  marker) want the unescaped value; `innerHTML` splices must wrap
 *  with `escapeHtml` because symbol names come from user-uploaded
 *  `.sym` files and could contain markup. */
function labelFor(addr: number, bank: number): string {
  const name = symbolFor(addr, bank);
  return name ?? hex4(addr);
}

/**
 * Call-stack pane for the Game Boy / Game Boy Color engine —
 * top-down view of the synthesized frames from
 * `gb/debug/call-stack.ts` (CALL / RST / IRQ pushes and RET pops).
 * The Game Boy Advance equivalent (`./callstack-pane-gba.ts`)
 * synthesises frames from BL / BX / LDM-with-PC / POP-with-PC + IRQ
 * entry. Top of the list is the innermost (most-recent) frame; the
 * current PC is shown separately at the top as a "here" marker.
 *
 * Refresh avoids rebuilding `innerHTML` on every rAF tick — the previous
 * implementation allocated a string of HTML and reassigned `innerHTML`
 * on every frame, which caused layout thrash and tooltip/selection loss
 * on the rows. We now diff a compact signature string of the frame
 * list and only rebuild when it actually changes; PC text is written
 * directly into a cached span every tick (cheap, preserves focus).
 */

interface Refs {
  here: HTMLDivElement;
  pcAddr: HTMLSpanElement;
  list: HTMLDivElement;
}

let refs: Refs | null = null;

/** Frame-list fingerprint from the last render. Includes kind, call
 *  site, and return addr for each frame; if this string matches the
 *  one we compute this tick, the DOM is already up to date. */
let lastSignature = "";
/** Last PC we wrote into `here.pcAddr`, used to skip redundant
 *  textContent writes when PC hasn't moved. */
let lastPcText = "";

export const callStackPane: Pane = {
  id: "callstack",
  label: "Call stack",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-cs");

    const here = document.createElement("div");
    here.className = "cs-here";
    const pcKind = document.createElement("span");
    pcKind.className = "cs-kind cs-kind-pc";
    pcKind.textContent = "PC";
    const pcAddr = document.createElement("span");
    pcAddr.className = "cs-addr";
    pcAddr.textContent = "—";
    here.append(pcKind, pcAddr);

    const list = document.createElement("div");
    list.className = "cs-list";

    container.append(here, list);
    refs = { here, pcAddr, list };
    lastSignature = "";
    lastPcText = "";
  },

  refresh(): void {
    if (!refs) return;
    const gb = state.gb;
    if (!gb) {
      if (lastPcText !== "no-rom") {
        refs.pcAddr.textContent = "No ROM";
        lastPcText = "no-rom";
      }
      if (lastSignature !== "") {
        refs.list.innerHTML = "";
        lastSignature = "";
      }
      return;
    }

    const bank = gb.cart.currentRomBank;
    const pcText = labelFor(gb.cpu.regs.pc, bank);
    if (pcText !== lastPcText) {
      refs.pcAddr.textContent = pcText;
      lastPcText = pcText;
    }

    const frames = frameList();
    // Signature captures the exact state that determines the rendered
    // DOM. Bank is included so symbol substitution updates when the
    // active ROM bank switches mid-frame.
    const sig = frames.map((f) => `${f.kind}:${f.callSite}:${f.returnAddr}`).join("|") + `@${bank}`;
    if (sig === lastSignature) return;
    lastSignature = sig;

    if (frames.length === 0) {
      refs.list.innerHTML = `<div class="cs-empty">stack is empty</div>`;
      return;
    }

    // Top of the list = innermost frame (most recent push).
    const lines: string[] = [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      const kindClass = `cs-kind-${f.kind}`;
      const kindLabel = f.kind === "call" ? "CALL" : f.kind === "rst" ? "RST" : "IRQ";
      lines.push(
        `<div class="cs-row">` +
          `<span class="cs-kind ${kindClass}">${kindLabel}</span>` +
          `<span class="cs-addr">${escapeHtml(labelFor(f.callSite, bank))}</span>` +
          `<span class="cs-arrow">→ ret</span>` +
          `<span class="cs-addr">${escapeHtml(labelFor(f.returnAddr, bank))}</span>` +
          `</div>`
      );
    }
    refs.list.innerHTML = lines.join("");
  }
};
