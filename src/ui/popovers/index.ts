import {
  cartInfoPop,
  cartInfoTrigger,
  cheatsPop,
  cheatsTrigger,
  debuggerPop,
  debuggerTrigger,
  morePop,
  moreTrigger,
  printerPop,
  printerTrigger,
  recentsPop,
  recentsTrigger,
  settingsPop,
  settingsTrigger,
  slotsPop,
  slotsTrigger
} from "../dom.js";
import { closeCartInfo, openCartInfo } from "./cart-info.js";
import { closeCheats, openCheats } from "./cheats.js";
import { closeDebugger, openDebugger } from "./debugger.js";
import { closeRecents, openRecents } from "./library.js";
import { closeMore, openMore } from "./more.js";
import { closePrinter, onPagePrinted, openPrinter, refreshPrinterTrigger } from "./printer.js";
import { closeSettings, openSettings } from "./settings.js";
import { closeSlots, doLoadState, doSaveState, openSlots } from "./slots.js";

/**
 * Popover barrel — re-exports every open/close function and wires the
 * cross-popover mutex on the triggers (clicking any popover trigger
 * closes the others) plus the document-level outside-click close.
 *
 * Keeping the mutex in one file avoids N-way circular imports between
 * the per-popover modules.
 */

export {
  openRecents,
  closeRecents,
  openSlots,
  closeSlots,
  doSaveState,
  doLoadState,
  openCheats,
  closeCheats,
  openCartInfo,
  closeCartInfo,
  openSettings,
  closeSettings,
  openDebugger,
  closeDebugger,
  openPrinter,
  closePrinter,
  onPagePrinted,
  refreshPrinterTrigger,
  openMore,
  closeMore
};

// ─── Trigger wiring (click mutex between popovers) ───────────────────────
// Central list so each popover's trigger click closes all the others.
// Mapping order doesn't matter; `wireTrigger` filters the clicked popover
// out of the "others to close" list at runtime.
interface PopoverEntry {
  trigger: HTMLButtonElement | null;
  pop: HTMLElement | null;
  open: () => void;
  close: () => void;
}

const popovers: readonly PopoverEntry[] = [
  { trigger: recentsTrigger, pop: recentsPop, open: openRecents, close: closeRecents },
  { trigger: slotsTrigger, pop: slotsPop, open: openSlots, close: closeSlots },
  { trigger: cheatsTrigger, pop: cheatsPop, open: openCheats, close: closeCheats },
  { trigger: cartInfoTrigger, pop: cartInfoPop, open: openCartInfo, close: closeCartInfo },
  { trigger: settingsTrigger, pop: settingsPop, open: openSettings, close: closeSettings },
  { trigger: debuggerTrigger, pop: debuggerPop, open: openDebugger, close: closeDebugger },
  { trigger: printerTrigger, pop: printerPop, open: openPrinter, close: closePrinter },
  { trigger: moreTrigger, pop: morePop, open: openMore, close: closeMore }
];

// ─── Focus management ───────────────────────────────────────────────────
// Tracks the element that held focus before the current popover opened so
// Escape / outside-click can send focus back there. Stays set across
// internal close()s (e.g. library card click → closeRecents) because
// those don't go through the dismiss() path — the next open() overwrites
// the ref and no stale restoration ever fires (dismiss() checks
// activeEntry() first).
let previousFocus: HTMLElement | null = null;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function activeEntry(): PopoverEntry | null {
  for (const e of popovers) if (e.pop?.classList.contains("open")) return e;
  return null;
}

function openEntry(entry: PopoverEntry): void {
  if (!entry.pop) return;
  previousFocus = document.activeElement as HTMLElement | null;
  // Let transient docked overlays (e.g. the translate overlay) dismiss
  // themselves so they don't float above the popover. Listener is in
  // translate-overlay.ts.
  window.dispatchEvent(new Event("gb-popover-open"));
  entry.open();
  // Wait for the popover's render() to finish before querying for
  // focusable children — most popovers rebuild their DOM inside open().
  requestAnimationFrame(() => {
    if (!entry.pop?.classList.contains("open")) return;
    const focusable = getFocusable(entry.pop);
    (focusable[0] ?? entry.pop).focus();
  });
}

function dismiss(entry: PopoverEntry, opts: { restoreFocus: boolean } = { restoreFocus: true }): void {
  entry.close();
  if (opts.restoreFocus && previousFocus && document.body.contains(previousFocus)) {
    previousFocus.focus();
  }
  if (opts.restoreFocus) previousFocus = null;
}

// Fixed × close button shown in narrow/touch viewports while any popover
// is open. The backdrop tap to dismiss also works, but on a phone it's a
// thin strip and not obviously a close target — this gives users a
// discoverable affordance without needing to hit that strip.
const closeButton = document.createElement("button");
closeButton.type = "button";
closeButton.className = "popover-close";
closeButton.setAttribute("aria-label", "Close");
closeButton.innerHTML = "&times;";
closeButton.addEventListener("click", (e) => {
  e.stopPropagation();
  const active = activeEntry();
  if (active) dismiss(active);
});
document.body.appendChild(closeButton);

// Mirror "any popover open" to a body class so CSS can show the close
// button. Observing class changes on each popover keeps this in sync no
// matter how the popover got opened — trigger click, hotkey-driven
// open*/close* (keyboard.ts, touch-actions.ts), or future paths.
const popoverClassObserver = new MutationObserver(() => {
  document.body.classList.toggle("popover-active", activeEntry() !== null);
});
for (const entry of popovers) {
  if (entry.pop) popoverClassObserver.observe(entry.pop, { attributes: true, attributeFilter: ["class"] });
}

for (const entry of popovers) {
  entry.trigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = entry.pop?.classList.contains("open") ?? false;
    // Close everyone else silently (about to focus into the new popover,
    // so skipping focus restore avoids a flicker through the old trigger).
    for (const other of popovers) if (other !== entry) dismiss(other, { restoreFocus: false });
    if (wasOpen) dismiss(entry, { restoreFocus: true });
    else openEntry(entry);
  });
  // Clicks inside the popover body shouldn't bubble to the document-level
  // outside-click handler below.
  entry.pop?.addEventListener("click", (e) => e.stopPropagation());
}

// Close any popover on outside click (mouse/touch). Focus returns to the
// trigger so keyboard users aren't stranded on <body>.
document.addEventListener("click", () => {
  const active = activeEntry();
  if (active) dismiss(active);
});

// Escape closes the active popover and restores focus. Bubble phase so
// capture-phase handlers (binding-chip capture, shortcut-hint overlay)
// still get first dibs — they stopImmediatePropagation when they care,
// which keeps the popover open through a cancelled rebind.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const active = activeEntry();
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  dismiss(active);
});

// Focus trap — wrap Tab / Shift+Tab around the first/last focusable
// element inside the active popover so keyboard users can't accidentally
// tab out into the header underneath (especially disorienting in modal
// mode at narrow widths where the backdrop is active).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const active = activeEntry();
  if (!active?.pop) return;
  const focusable = getFocusable(active.pop);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const current = document.activeElement;
  // If focus somehow drifted outside the popover (e.g. programmatic
  // focus change), pull it back to the first/last entry.
  if (!active.pop.contains(current)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && current === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && current === last) {
    e.preventDefault();
    first.focus();
  }
});
