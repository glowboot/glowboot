import { morePop, moreTrigger } from "../dom.js";
import { createPopover } from "./helper.js";

/**
 * "More" overflow menu — shown at narrow viewports where the secondary
 * action icons (Cheats, Debugger, Fullscreen, Printer, About) would
 * otherwise wrap onto a second row in the header. The menu items don't
 * carry their own logic; each one click()s the corresponding original
 * trigger button (`data-mirrors="<id>"`), so all the existing wiring —
 * popover mutex, ROM-loaded enable/disable state, focus management —
 * continues to work unchanged.
 *
 * Each menu item mirrors the disabled state of its target trigger on
 * every open: Cheats / Debugger are disabled until a ROM is loaded,
 * Printer is disabled until link-cable mode is set to "printer". A
 * disabled trigger bubbles through to a disabled menu item so the
 * user gets the same "you can't tap this right now" feedback inside
 * the More menu as they would on the inline icons.
 */

const { open: openMore, close: closeMore } = createPopover({
  trigger: moreTrigger,
  pop: morePop,
  onOpen: syncDisabledStates
});

export { openMore, closeMore };

/** Copy each mirror target's `disabled` flag (and its `title`, so the
 *  "load a ROM first" hint surfaces on long-press / hover here too)
 *  onto its menu item. Re-checked on every open since the underlying
 *  state (ROM loaded, printer mode active) can change while the
 *  popover is closed. */
function syncDisabledStates(): void {
  if (!morePop) return;
  for (const item of morePop.querySelectorAll<HTMLButtonElement>(".more-item[data-mirrors]")) {
    const id = item.dataset.mirrors;
    const target = id ? document.getElementById(id) : null;
    if (target instanceof HTMLButtonElement) {
      item.disabled = target.disabled;
      if (target.title) item.title = target.title;
    } else {
      item.disabled = false;
    }
  }
}

// Mirror clicks: each `.more-item` clicks the original trigger by id.
// The trigger's own click handler (registered in popovers/index.ts)
// closes any open popover (including this More menu) via the cross-
// popover mutex and then opens its target — no extra coordination
// required here. Disabled buttons don't fire click events, so a
// disabled menu item is naturally a no-op.
for (const item of document.querySelectorAll<HTMLButtonElement>(".more-item[data-mirrors]")) {
  const id = item.dataset.mirrors;
  item.addEventListener("click", () => {
    const target = id ? document.getElementById(id) : null;
    if (target instanceof HTMLButtonElement) target.click();
  });
}
