import { frameList, symbolFor } from "../../nes";
import { state } from "../state.js";
import { escapeHtml, hex4 } from "./format.js";
import type { Pane } from "./pane.js";

/** Symbol-name or hex fallback. Returns the raw string — callers
 *  splicing into `innerHTML` (the frame list) must wrap with
 *  `escapeHtml`; `textContent` consumers (PC marker) use the value
 *  as-is. Symbol names come from user-uploaded `.sym` / `.nl` files
 *  and could contain markup. NES symbols are flat 16-bit (no bank). */
function labelFor(addr: number): string {
  return symbolFor(addr) ?? hex4(addr);
}

/**
 * NES call-stack pane. Mirrors the GB version's diff-based rebuild:
 * a fingerprint string of the live frame list is compared against
 * the last-rendered one and only changes touch the DOM. The current
 * PC is shown separately at the top as a "here" marker, written every
 * tick (cheap, preserves focus).
 *
 * Differences from the GB pane:
 *   - 16-bit addresses with no bank dimension (NES banking is
 *     mapper-specific and dynamic, so symbols key on the 16-bit CPU
 *     address only).
 *   - Frame kinds are `"jsr"` (JSR push), `"brk"` (software interrupt),
 *     `"irq"` (maskable), or `"nmi"` (V-Blank). No GB `RST` analogue.
 *
 * The pane reads `frameList()` (engine-side module
 * `src/nes/debug/call-stack.ts`) which is updated as JSR/BRK push and
 * RTS/RTI pop, plus IRQ / NMI dispatch entries. Best-effort by design —
 * see the module header for the false-positive caveats.
 */

interface Refs {
  here: HTMLDivElement;
  pcAddr: HTMLSpanElement;
  list: HTMLDivElement;
}

let refs: Refs | null = null;
let lastSignature = "";
let lastPcText = "";

export const callStackPaneNes: Pane = {
  id: "callstack",
  label: "Call Stack",

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
    const nes = state.nes;
    if (!nes) {
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

    const pcText = labelFor(nes.cpu.pc);
    if (pcText !== lastPcText) {
      refs.pcAddr.textContent = pcText;
      lastPcText = pcText;
    }

    const frames = frameList();
    // Include symbol-resolution state in the signature so loading a
    // new symbol file forces a rebuild with the fresh names.
    const symFingerprint = frames.length === 0 ? "" : labelFor(frames[0]!.callSite);
    const sig = frames.map((f) => `${f.kind}:${f.callSite}:${f.returnAddr}`).join("|") + `@${symFingerprint}`;
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
      const kindLabel = f.kind.toUpperCase();
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
