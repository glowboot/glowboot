import { canvas, slotsPop, slotsTrigger } from "../dom.js";
import { relativeTime } from "../format.js";
import { confirmAction, promptText } from "../hud/modal.js";
import { errorToast, toast } from "../hud/toast.js";
import { downloadSlot, importStateFile } from "../persistence/io/state.js";
import * as SaveState from "../persistence/save-state.js";
import { state } from "../state.js";
import { createPopover } from "./helper.js";

/**
 * Save-state slot popover — 10 cards per cart with thumbnails captured
 * at save time. Hover reveals per-slot Save (↓) and Clear (×) buttons;
 * the card body loads the slot. `doSaveState` and `doLoadState` are
 * exported so the keyboard shortcuts (digit / Shift+digit) can trigger
 * the same actions.
 */

export async function doSaveState(slot = 0): Promise<void> {
  const gb = state.gb;
  if (!gb) return;
  // Guard against accidentally clobbering a user-labelled save. The
  // label is the user's signal that the contents mean something (e.g.
  // "Before Ganon") — overwriting an anonymous "#3" slot stays
  // silent to keep rapid-fire saves unobtrusive.
  const existing = (await SaveState.listSlots(gb.cart)).find((s) => s.slot === slot);
  if (existing?.label) {
    const ok = await confirmAction({
      title: `Overwrite "${existing.label}"?`,
      body: `Slot ${slot} already holds a labelled save. Saving now replaces it.`,
      confirmLabel: "Overwrite",
      danger: true
    });
    if (!ok) return;
  }
  // Capture a PNG thumbnail of the current frame so the slot popover can
  // show a recognisable preview. Best-effort — if toDataURL throws we
  // still persist the state without the image.
  let thumb: string | undefined;
  try {
    thumb = canvas.toDataURL("image/png");
  } catch {
    /* skip thumb */
  }
  const ok = await SaveState.saveStateTo(gb, slot, thumb);
  if (ok) state.lastStateAt = performance.now();
  toast(ok ? `Saved slot ${slot}` : `Save ${slot} failed`);
  if (slotsPop?.classList.contains("open")) void renderSlots();
}

/** Minimum unsaved-play threshold before load prompts the user. Shorter
 *  sessions don't warn — they're probably just slot hopping. */
const LOAD_WARN_MS = 2 * 60 * 1000;

export async function doLoadState(slot = 0): Promise<void> {
  const gb = state.gb;
  if (!gb) return;
  if (!(await SaveState.hasState(gb.cart, slot))) {
    toast(`Slot ${slot} empty`);
    return;
  }
  // Warn when the user has been playing for a while since the last
  // save/load — an accidental digit press (e.g. typing 3 instead of
  // Shift+3) would otherwise silently jump the engine back. Recent
  // save/load activity skips the prompt so quick A/B comparisons
  // between slots stay frictionless.
  const now = performance.now();
  const anchor = Math.max(state.lastStateAt, state.runStartMs);
  if (anchor > 0 && now - anchor > LOAD_WARN_MS) {
    const ok = await confirmAction({
      title: `Load slot ${slot}?`,
      body: "Current progress will be replaced. Hold Backspace afterwards to rewind if you changed your mind.",
      confirmLabel: "Load",
      danger: true
    });
    if (!ok) return;
  }
  const ok = await SaveState.loadStateFrom(gb, slot);
  if (ok) state.lastStateAt = performance.now();
  toast(ok ? `Loaded slot ${slot}` : `Load ${slot} failed`);
}

export const { open: openSlots, close: closeSlots } = createPopover({
  trigger: slotsTrigger,
  pop: slotsPop,
  render: renderSlots
});

/** Open one slot overflow at a time. Toggling an already-open one
 *  closes it; opening a different one closes the previous. */
function toggleOverflow(el: HTMLElement): void {
  const wasOpen = el.classList.contains("is-open");
  closeAllSlotOverflows();
  if (!wasOpen) {
    el.classList.add("is-open");
    el.querySelector(".slot-overflow-trigger")?.setAttribute("aria-expanded", "true");
  }
}

function closeAllSlotOverflows(): void {
  if (!slotsPop) return;
  for (const el of slotsPop.querySelectorAll<HTMLElement>(".slot-overflow.is-open")) {
    el.classList.remove("is-open");
    el.querySelector(".slot-overflow-trigger")?.setAttribute("aria-expanded", "false");
  }
}

// Outside-click + Escape close any open overflow menu. Listeners live
// at document level so a click anywhere outside the menu (other slot
// card body, popover backdrop, …) dismisses it. Click events on the
// trigger and menu items already stopPropagation, so they don't reach
// here while the menu is supposed to stay open.
document.addEventListener("click", (e) => {
  if (!slotsPop?.classList.contains("open")) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest(".slot-overflow.is-open")) return;
  closeAllSlotOverflows();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!slotsPop?.querySelector(".slot-overflow.is-open")) return;
  e.stopPropagation();
  closeAllSlotOverflows();
});

async function renderSlots(): Promise<void> {
  if (!slotsPop) return;
  slotsPop.innerHTML = "";
  const gb = state.gb;
  if (!gb) {
    const msg = document.createElement("div");
    msg.className = "pop-empty";
    msg.textContent = "Load a ROM to see save slots";
    slotsPop.appendChild(msg);
    return;
  }

  // Toolbar — single "Import state…" button. Opens a file picker for
  // `.gbstate` files. The import module validates the cartId matches
  // the currently-loaded cart; mismatches show a toast and abort.
  const toolbar = document.createElement("div");
  toolbar.className = "slots-toolbar";
  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "slots-import";
  importBtn.textContent = "Import state…";
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = ".gbstate,application/json";
  importInput.hidden = true;
  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      errorToast("Could not read file");
      return;
    }
    const result = await importStateFile(gb.cart, text);
    if (!result.ok) {
      toast(result.reason ?? "Import failed");
      return;
    }
    toast(`Imported slot ${result.slot}`);
    void renderSlots();
  });
  toolbar.appendChild(importBtn);
  toolbar.appendChild(importInput);
  slotsPop.appendChild(toolbar);

  const grid = document.createElement("div");
  grid.className = "slots-grid";
  const populated = new Map<number, SaveState.SlotInfo>();
  for (const s of await SaveState.listSlots(gb.cart)) populated.set(s.slot, s);

  for (let slot = 0; slot < SaveState.SLOT_COUNT; slot++) {
    const info = populated.get(slot);
    const card = document.createElement("button");
    card.className = info ? "slot-card" : "slot-card empty";
    card.title = info ? `Load slot ${slot}` : `Slot ${slot} (empty)`;

    const thumb = document.createElement("div");
    thumb.className = "slot-thumb";
    // See library.ts for why this is a custom property rather than a
    // direct style.backgroundImage write.
    if (info?.thumb) thumb.style.setProperty("--thumb", `url("${info.thumb}")`);
    else thumb.textContent = "—";
    card.appendChild(thumb);

    const meta = document.createElement("div");
    meta.className = "slot-meta";
    const num = document.createElement("span");
    num.className = "slot-num";
    // User-entered labels win the primary line so the slot reads as
    // "Before Ganon" rather than "#3"; the digit is still implicit via
    // the keyboard hotkey (Shift+N saves, N loads).
    num.textContent = info?.label ? info.label : `#${slot}`;
    if (info?.label) {
      num.classList.add("labeled");
      num.title = `Slot ${slot} — ${info.label}`;
    }
    const time = document.createElement("span");
    time.className = "slot-time";
    time.textContent = info ? relativeTime(info.savedAt) : "empty";
    meta.appendChild(num);
    meta.appendChild(time);
    card.appendChild(meta);

    // Per-card action affordances. Save is always inline; the
    // secondary actions (Rename / Export / Clear) fold behind a ⋮
    // overflow menu so an occupied card stays visually quiet.
    // stopPropagation everywhere so clicking an action doesn't also
    // trigger the card-body load handler below.
    const actions = document.createElement("div");
    actions.className = "slot-actions";
    const saveBtn = document.createElement("button");
    saveBtn.className = "slot-action save";
    saveBtn.title = `Save to slot ${slot}`;
    saveBtn.setAttribute("aria-label", `Save to slot ${slot}`);
    saveBtn.textContent = "↓";
    saveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await doSaveState(slot);
    });
    actions.appendChild(saveBtn);
    if (info) {
      const overflow = document.createElement("div");
      overflow.className = "slot-overflow";

      const overflowBtn = document.createElement("button");
      overflowBtn.className = "slot-action slot-overflow-trigger";
      overflowBtn.title = `More actions for slot ${slot}`;
      overflowBtn.setAttribute("aria-label", `More actions for slot ${slot}`);
      overflowBtn.setAttribute("aria-haspopup", "menu");
      overflowBtn.setAttribute("aria-expanded", "false");
      overflowBtn.textContent = "⋮";
      overflowBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleOverflow(overflow);
      });
      overflow.appendChild(overflowBtn);

      const menu = document.createElement("div");
      menu.className = "slot-overflow-menu";
      menu.setAttribute("role", "menu");

      const renameItem = document.createElement("button");
      renameItem.className = "slot-overflow-item";
      renameItem.setAttribute("role", "menuitem");
      renameItem.innerHTML = `<span class="slot-overflow-icon">✎</span><span>${info.label ? "Rename" : "Label"}</span>`;
      renameItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeAllSlotOverflows();
        const next = await promptText({
          title: `Slot ${slot} label`,
          placeholder: "e.g. Before Ganon",
          value: info.label ?? "",
          confirmLabel: "Save"
        });
        if (next === null) return; // user cancelled
        await SaveState.setSlotLabel(gb.cart, slot, next);
        void renderSlots();
      });
      menu.appendChild(renameItem);

      const exportItem = document.createElement("button");
      exportItem.className = "slot-overflow-item";
      exportItem.setAttribute("role", "menuitem");
      exportItem.innerHTML = `<span class="slot-overflow-icon">⤓</span><span>Export</span>`;
      exportItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeAllSlotOverflows();
        const ok = await downloadSlot(gb.cart, slot);
        toast(ok ? `Exported slot ${slot}` : `Export ${slot} failed`);
      });
      menu.appendChild(exportItem);

      const clearItem = document.createElement("button");
      clearItem.className = "slot-overflow-item danger";
      clearItem.setAttribute("role", "menuitem");
      clearItem.innerHTML = `<span class="slot-overflow-icon">×</span><span>Clear</span>`;
      clearItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeAllSlotOverflows();
        const ok = await confirmAction({
          title: `Clear slot ${slot}?`,
          body: info.label
            ? `"${info.label}" will be deleted. This can't be undone.`
            : `This save state will be deleted. This can't be undone.`,
          confirmLabel: "Clear",
          danger: true
        });
        if (!ok) return;
        await SaveState.clearSlot(gb.cart, slot);
        toast(`Cleared slot ${slot}`);
        void renderSlots();
      });
      menu.appendChild(clearItem);

      overflow.appendChild(menu);
      actions.appendChild(overflow);
    }
    card.appendChild(actions);

    card.addEventListener("click", () => {
      if (!info) {
        toast(`Slot ${slot} empty`);
        return;
      }
      void doLoadState(slot);
      closeSlots();
    });

    grid.appendChild(card);
  }
  slotsPop.appendChild(grid);
}
