/**
 * Shared open/close behaviour for every popover trigger pair: render
 * → toggle the `.open` class → sync `aria-expanded` on the trigger.
 *
 * The focus-management layer in popovers/index.ts still owns Escape,
 * focus trap, and focus restoration — this helper only covers the
 * per-popover mechanics, so the trigger click mutex and dialog roles
 * keep working unchanged.
 */

export interface PopoverSpec {
  trigger: HTMLButtonElement | null;
  pop: HTMLElement | null;

  /** Called on every open() before the popover becomes visible. Most
   *  popovers use it to (re)render their contents. Async is allowed —
   *  the return value is discarded; the popover opens immediately and
   *  the render resolves in the background (matches the previous
   *  `void renderX()` pattern the hand-rolled open() functions used). */
  render?: () => unknown;
  /** Optional side-effect run before render on open. Used by cart-info
   *  to flush the play-time counter and by library to reset the search
   *  term. Separate from render so a rerender caller (e.g. "add cheat
   *  → rerender" in cheats.ts) doesn't re-fire the side-effect. */
  onOpen?: () => void;
}

export interface PopoverHandle {
  open: () => void;
  close: () => void;
}

export function createPopover(spec: PopoverSpec): PopoverHandle {
  const { trigger, pop, render, onOpen } = spec;

  function open(): void {
    if (!pop) return;
    onOpen?.();
    if (render) void render();
    pop.classList.add("open");
    trigger?.setAttribute("aria-expanded", "true");
  }

  function close(): void {
    if (!pop) return;
    pop.classList.remove("open");
    trigger?.setAttribute("aria-expanded", "false");
  }

  return { open, close };
}
