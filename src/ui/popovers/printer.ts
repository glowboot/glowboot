import type { PrintedPage } from "../../gb";
import { printerPop, printerTrigger } from "../dom.js";
import { confirmAction } from "../hud/modal.js";
import { toast } from "../hud/toast.js";
import {
  clearAllPrintouts,
  deletePrintout,
  listPrintouts,
  persistPrintout,
  type StoredPrintout
} from "../persistence/printouts.js";
import { saveBlobNative } from "../save-blob.js";
import { state } from "../state.js";
import { createPopover } from "./helper.js";

/**
 * Printer popover — shared queue of every page captured by the
 * virtual Game Boy Printer link, across every cart. History is
 * persisted in IndexedDB (`printouts` store) so prints survive page
 * reloads, link-mode toggles, and ROM swaps. The conceptual model is
 * "the printer's tray" rather than "this cart's tray" — switching
 * games doesn't hide your earlier prints.
 *
 * The trigger button is `disabled` until Settings → Link cable →
 * Printer is picked; panels.ts toggles the disabled state.
 */

let printouts: StoredPrintout[] = [];

/** Whether the in-memory `printouts` list has been hydrated from IDB
 *  yet. Used to lazily load on first open without thrashing IDB on
 *  every render. */
let loaded = false;
/** Whether the link-cable setting is currently "printer". Mirrors
 *  `panels.ts`'s syncMode — the trigger is enabled when this is true
 *  OR when at least one print has been captured (so users can
 *  re-open old history without first toggling the link mode back on). */
let linkIsPrinter = false;

export const { open: openPrinter, close: closePrinter } = createPopover({
  trigger: printerTrigger,
  pop: printerPop,
  render: renderPrinter
});

/** Engine callback — invoked by `PrinterLink` when the guest emits a
 *  PRINT command. Persists the page to IDB tagged with the active
 *  cart's id, then prepends the new record to the shared in-memory
 *  queue and re-renders if the popover is open. */
export async function onPagePrinted(page: PrintedPage): Promise<void> {
  const cart = state.gb?.cart;
  if (!cart) return;
  let record: StoredPrintout;
  try {
    record = await persistPrintout(cart, page);
  } catch (err) {
    console.warn("[Printer] failed to persist page:", err);
    toast("Could not save print to history");
    return;
  }
  // Only push into the in-memory list once it's been hydrated from
  // IDB — otherwise the next renderPrinter would overwrite our
  // unshift with the freshly-loaded list anyway.
  if (loaded) printouts.unshift(record);
  syncTriggerState();
  toast(`Printed (${page.width}×${page.height})`);
  if (printerPop?.classList.contains("open")) void renderPrinter();
}

/** Called by `settings/panels.ts` on every link-mode change so the
 *  printer trigger reflects "printer mode is on" without panels.ts
 *  needing to know about the persisted-prints case. */
export function setLinkModeIsPrinter(on: boolean): void {
  linkIsPrinter = on;
  syncTriggerState();
}

/** Update the printer-trigger's disabled flag based on the current
 *  state of all three inputs. Called whenever any input changes:
 *    - link-cable mode toggled (via `setLinkModeIsPrinter`)
 *    - printouts list mutated (load / add / delete / clear)
 *    - ROM loaded (via `refreshPrinterTrigger` from rom-loader)
 *  Title swaps with state so the user always sees the next actionable
 *  step. Order matters: when no ROM has been loaded yet we surface
 *  the same "load a ROM to use" hint as the other action-row buttons,
 *  so the user's first step is consistent across every disabled icon.
 *  Once a ROM is in but the link cable isn't set to Printer (and no
 *  history exists), we point at the Settings step that's missing. */
function syncTriggerState(): void {
  if (!printerTrigger) return;
  const hasPrints = printouts.length > 0;
  const enabled = linkIsPrinter || hasPrints;
  printerTrigger.disabled = !enabled;
  if (enabled) {
    printerTrigger.title = "Printer";
  } else if (state.gb === null) {
    printerTrigger.title = "Printer — load a ROM to use";
  } else {
    printerTrigger.title = "Printer — set Link cable to Printer in Settings";
  }
}

/** Re-evaluate the printer trigger's enabled / title state. Called
 *  by `rom-loader.ts` once a cart has booted so the disabled hint can
 *  swap from "load a ROM to use" to "set Link cable to Printer in
 *  Settings" without users having to click into the popover first. */
export function refreshPrinterTrigger(): void {
  syncTriggerState();
}

// Eagerly hydrate the print history at module load so the trigger's
// enabled state reflects persisted prints from the very first paint —
// otherwise users who reload mid-session would see a disabled icon
// even though their printouts are sitting in IDB. Lazy-loading-only
// would require the popover to be opened first, which the disabled
// trigger doesn't allow.
void (async () => {
  await ensureLoaded();
  syncTriggerState();
})();

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    printouts = await listPrintouts();
  } catch (err) {
    console.warn("[Printer] failed to load history:", err);
    printouts = [];
  }
  loaded = true;
}

async function renderPrinter(): Promise<void> {
  if (!printerPop) return;
  await ensureLoaded();
  printerPop.innerHTML = "";

  const header = document.createElement("h3");
  header.className = "printer-title";
  header.textContent = "Game Boy Printer";
  printerPop.appendChild(header);

  if (printouts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pop-empty";
    empty.textContent =
      "No prints captured yet. Use a printer-aware game (Pokémon Pokédex, Game Boy Camera, …) and trigger an in-game print.";
    printerPop.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "printer-list";
  for (let i = 0; i < printouts.length; i++) list.appendChild(renderEntry(printouts[i]!, i));
  printerPop.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "printer-footer";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "printer-clear-btn";
  clearBtn.textContent = "Clear all";
  clearBtn.addEventListener("click", () => void clearAll());
  footer.appendChild(clearBtn);
  printerPop.appendChild(footer);
}

function renderEntry(record: StoredPrintout, index: number): HTMLElement {
  const entry = document.createElement("div");
  entry.className = "printer-entry";

  // 4-stop greyscale palette mirroring the DMG screen — black text on
  // a light cream paper feels more "thermal printer" than literal
  // black-on-white. Maps source 0..3 to ARGB tuples.
  const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
    [0xfa, 0xf3, 0xe0], // paper
    [0xa8, 0xa0, 0x80],
    [0x55, 0x55, 0x55],
    [0x10, 0x10, 0x10] // ink
  ];

  const canvas = document.createElement("canvas");
  canvas.width = record.width;
  canvas.height = record.height;
  // Scale 2× for legibility on retina screens; CSS keeps it crisp.
  canvas.style.width = `${record.width * 2}px`;
  canvas.style.height = `${record.height * 2}px`;
  canvas.className = "printer-canvas";
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(record.width, record.height);
    for (let i = 0; i < record.pixels.length; i++) {
      const v = record.pixels[i]!;
      const [r, g, b] = PALETTE[v]!;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // Hover-revealed action buttons sit on top of the thumbnail itself
  // — same pattern as the slot/library cards. Download icon top-right,
  // delete X next to it. Touch devices show them always (see CSS).
  const actions = document.createElement("div");
  actions.className = "printer-actions";

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "printer-action printer-action-download";
  downloadBtn.setAttribute("aria-label", "Download print as PNG");
  downloadBtn.title = "Download PNG";
  downloadBtn.textContent = "⤓";
  downloadBtn.addEventListener("click", () => void saveCanvas(canvas, record, index));

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "printer-action printer-action-delete";
  deleteBtn.setAttribute("aria-label", "Delete this print");
  deleteBtn.title = "Delete";
  deleteBtn.textContent = "×";
  deleteBtn.addEventListener("click", () => void deleteSingle(record.id));

  actions.append(downloadBtn, deleteBtn);

  entry.appendChild(canvas);
  entry.appendChild(actions);
  return entry;
}

/** Remove one persisted printout, then re-render. Asks for confirmation
 *  first since deletion is irreversible — the only "undo" is hoping
 *  the guest game prints the same page again. */
async function deleteSingle(id: string): Promise<void> {
  const ok = await confirmAction({
    title: "Delete this print?",
    body: "The image will be removed from your printer history. This can't be undone.",
    confirmLabel: "Delete",
    danger: true
  });
  if (!ok) return;
  try {
    await deletePrintout(id);
  } catch (err) {
    console.warn("[Printer] failed to delete printout:", err);
    toast("Could not delete print");
    return;
  }
  printouts = printouts.filter((p) => p.id !== id);
  syncTriggerState();
  if (printerPop?.classList.contains("open")) void renderPrinter();
}

/** Wipe the entire printer queue, then re-render with the empty
 *  state. Independent of which cart is active. Asks for confirmation
 *  first — clearing every saved print at once is the most destructive
 *  action in the popover. */
async function clearAll(): Promise<void> {
  const ok = await confirmAction({
    title: "Clear all prints?",
    body: `Every saved print (${printouts.length}) will be removed from your printer history. This can't be undone.`,
    confirmLabel: "Clear all",
    danger: true
  });
  if (!ok) return;
  try {
    await clearAllPrintouts();
  } catch (err) {
    console.warn("[Printer] failed to clear history:", err);
    toast("Could not clear prints");
    return;
  }
  printouts = [];
  syncTriggerState();
  if (printerPop?.classList.contains("open")) void renderPrinter();
}

async function saveCanvas(canvas: HTMLCanvasElement, record: StoredPrintout, index: number): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  if (!blob) {
    toast("Could not encode PNG");
    return;
  }
  const cartTitle = state.gb?.cart.title?.trim() || "gameboy";
  const safeTitle = cartTitle.replace(/[^A-Za-z0-9_.-]/g, "_") || "gameboy";
  const stamp = new Date(record.savedAt).toISOString().replace(/[:.]/g, "-");
  const filename = `${safeTitle}-print${index + 1}-${stamp}.png`;
  const share = await saveBlobNative(blob, filename);
  if (share === "shared") {
    toast("Print ready to share");
    return;
  }
  if (share === "cancelled") {
    toast("Print cancelled");
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
