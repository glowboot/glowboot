import { frameListSnes, snesSymbolFor } from "../../snes";
import { state } from "../state.js";
import { escapeHtml, hex6 } from "./format.js";
import type { Pane } from "./pane.js";

/** Symbol-name or hex fallback. Returns the raw string — callers
 *  splicing into `innerHTML` (the frame list) must wrap with
 *  `escapeHtml`; `textContent` consumers (PC marker) use the value
 *  as-is. Symbol names come from user-uploaded symbol files and could
 *  contain markup. */
function labelFor(addr: number): string {
  return snesSymbolFor(addr) ?? hex6(addr);
}

/**
 * SNES call-stack pane. Mirrors the GBA version's diff-based rebuild:
 * a fingerprint string of the live frame list is compared against
 * the last-rendered one and only changes touch the DOM.
 *
 * Differences from the GBA pane:
 *   - 24-bit addresses (`$BB:AAAA` everywhere).
 *   - Frame kinds are `"jsr"` (same-bank) or `"jsl"` (cross-bank) —
 *     the 65C816 has real subroutine opcodes, so each row shows the
 *     call site and the call *target* rather than a return address.
 *
 * The pane reads `frameListSnes()` (engine-side module
 * `src/snes/debug/call-stack.ts`) which is updated as JSR / JSL / RTS /
 * RTL hit their tap calls inside the CPU dispatch. Best-effort by
 * design — see the module header for the desync caveats.
 */

interface Refs {
  here: HTMLDivElement;
  pcAddr: HTMLSpanElement;
  list: HTMLDivElement;
}

let refs: Refs | null = null;
let lastSignature = "";
let lastPcText = "";

export const callStackPaneSnes: Pane = {
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
    const snes = state.snes;
    if (!snes) {
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

    const pcText = labelFor((snes.cpu.pbr << 16) | snes.cpu.pc);
    if (pcText !== lastPcText) {
      refs.pcAddr.textContent = pcText;
      lastPcText = pcText;
    }

    const frames = frameListSnes();
    // Include symbol-resolution state in the signature so loading a
    // new symbol file forces a rebuild with the fresh names.
    const symFingerprint = frames.length === 0 ? "" : labelFor(frames[0]!.from);
    const sig = frames.map((f) => `${f.kind}:${f.from}:${f.to}`).join("|") + `@${symFingerprint}`;
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
      const kindLabel = f.kind === "jsr" ? "JSR" : "JSL";
      lines.push(
        `<div class="cs-row">` +
          `<span class="cs-kind ${kindClass}">${kindLabel}</span>` +
          `<span class="cs-addr">${escapeHtml(labelFor(f.from))}</span>` +
          `<span class="cs-arrow">→</span>` +
          `<span class="cs-addr">${escapeHtml(labelFor(f.to))}</span>` +
          `</div>`
      );
    }
    refs.list.innerHTML = lines.join("");
  }
};
