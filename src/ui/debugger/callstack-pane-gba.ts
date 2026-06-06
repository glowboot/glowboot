import { frameListGba, gbaSymbolFor } from "../../gba";
import { state } from "../state.js";
import { escapeHtml, hex8 } from "./format.js";
import type { Pane } from "./pane.js";

/** Symbol-name or hex fallback. Returns the raw string — callers
 *  splicing into `innerHTML` (the frame list) must wrap with
 *  `escapeHtml`; `textContent` consumers (PC marker) use the value
 *  as-is. Symbol names come from user-uploaded `.sym` / `.map`
 *  files and could contain markup. */
function labelFor(addr: number): string {
  return gbaSymbolFor(addr) ?? hex8(addr);
}

/**
 * GBA call-stack pane. Mirrors the GB version's diff-based rebuild:
 * a fingerprint string of the live frame list is compared against
 * the last-rendered one and only changes touch the DOM.
 *
 * Differences from the GB pane:
 *   - 32-bit addresses (`$XXXXXXXX` everywhere).
 *   - No symbol resolution yet — a future Symbols pane (Phase 4d) can
 *     hook in here later. Labels render as plain hex.
 *   - Frame kinds are `"call"` (BL / Thumb BL pair) or `"irq"`. No GB
 *     `RST` analogue on ARM7TDMI.
 *
 * The pane reads `frameListGba()` (engine-side module
 * `src/gba/debug/call-stack.ts`) which is updated as BL pushes / BX /
 * LDM-with-PC / Thumb POP-with-PC / IRQ entry hit their tap calls
 * inside the CPU dispatch. Best-effort by design — see the module
 * header for the false-positive caveats.
 */

interface Refs {
  here: HTMLDivElement;
  pcAddr: HTMLSpanElement;
  list: HTMLDivElement;
}

let refs: Refs | null = null;
let lastSignature = "";
let lastPcText = "";

export const callStackPaneGba: Pane = {
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
    const gba = state.gba;
    if (!gba) {
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

    const pcText = labelFor(gba.cpu.regs.r[15]! >>> 0);
    if (pcText !== lastPcText) {
      refs.pcAddr.textContent = pcText;
      lastPcText = pcText;
    }

    const frames = frameListGba();
    // Include symbol-resolution state in the signature so loading a
    // new .sym file forces a rebuild with the fresh names.
    const symFingerprint = frames.length === 0 ? "" : labelFor(frames[0]!.callSite);
    const sig = frames.map((f) => `${f.kind}:${f.callSite}:${f.returnAddr}`).join("|") + `@${symFingerprint}`;
    if (sig === lastSignature) return;
    lastSignature = sig;

    if (frames.length === 0) {
      refs.list.innerHTML = `<div class="cs-empty">stack is empty</div>`;
      return;
    }

    const lines: string[] = [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      const kindClass = `cs-kind-${f.kind}`;
      const kindLabel = f.kind === "call" ? "CALL" : "IRQ";
      lines.push(
        `<div class="cs-row">` +
          `<span class="cs-kind ${kindClass}">${kindLabel}</span>` +
          `<span class="cs-addr">${escapeHtml(labelFor(f.callSite))}</span>` +
          `<span class="cs-arrow">→ ret</span>` +
          `<span class="cs-addr">${escapeHtml(labelFor(f.returnAddr))}</span>` +
          `</div>`
      );
    }
    refs.list.innerHTML = lines.join("");
  }
};
