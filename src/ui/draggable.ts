/** Make a `position: fixed` panel draggable by a handle element, remembering
 *  its position in localStorage. Used by the translate overlay.
 *  Positions the panel immediately (restoring the saved spot, or defaulting to
 *  the bottom-right corner clear of the centred game canvas) and clamps to the
 *  viewport so it can never be dragged or restored off-screen. */

import { lsGet, lsSet } from "./persistence/local-storage.js";

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const maxLeft = (panel: HTMLElement): number => Math.max(8, window.innerWidth - panel.offsetWidth - 8);
const maxTop = (panel: HTMLElement): number => Math.max(8, window.innerHeight - panel.offsetHeight - 8);

/**
 * @param panel   the fixed-positioned panel to move
 * @param handle  the element that starts a drag (e.g. the panel header)
 * @param posKey  localStorage key to persist `{x,y}` under
 * @param exclude an element inside `handle` that should NOT start a drag
 *                (e.g. the close button)
 */
export function makeDraggablePanel(
  panel: HTMLElement,
  handle: HTMLElement,
  posKey: string,
  exclude?: HTMLElement | null
): void {
  // Initial placement: saved position (clamped to the current viewport) or the
  // bottom-right corner.
  let x = maxLeft(panel);
  let y = maxTop(panel);
  try {
    const saved = lsGet(posKey);
    if (saved) {
      const p = JSON.parse(saved) as { x?: number; y?: number };
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        x = p.x as number;
        y = p.y as number;
      }
    }
  } catch {
    /* malformed saved position — fall back to the corner */
  }
  panel.style.left = `${clamp(x, 8, maxLeft(panel))}px`;
  panel.style.top = `${clamp(y, 8, maxTop(panel))}px`;

  handle.addEventListener("pointerdown", (e) => {
    if (exclude && (e.target === exclude || exclude.contains(e.target as Node))) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent): void => {
      panel.style.left = `${clamp(ev.clientX - offX, 8, maxLeft(panel))}px`;
      panel.style.top = `${clamp(ev.clientY - offY, 8, maxTop(panel))}px`;
    };
    const onUp = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      lsSet(posKey, JSON.stringify({ x: parseFloat(panel.style.left), y: parseFloat(panel.style.top) }));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}
