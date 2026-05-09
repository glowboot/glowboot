/**
 * On-screen touch-control layout — three knobs the user can tune in
 * Settings → Controls → Touch layout:
 *
 *   - **mirror**  — swap D-pad and A/B columns for left-handed players.
 *   - **scale**   — global size multiplier for every control. 0.7..1.4.
 *   - **spacing** — pixel gap between the D-pad and A/B columns. 0..60.
 *
 * Values are applied as CSS custom properties on the `.gb-touch`
 * overlay, so the existing CSS grid keeps doing its job; this module
 * only adjusts the dials. Persisted in `localStorage` keyed under
 * `gb-touch-layout`.
 */

import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";

export interface TouchLayout {
  mirror: boolean;
  scale: number;
  spacing: number;
}

export const DEFAULT_TOUCH_LAYOUT: TouchLayout = {
  mirror: false,
  scale: 1.1,
  spacing: 20
};

const MIN_SCALE = 0.7;
const MAX_SCALE = 1.4;
const MIN_SPACING = 0;
const MAX_SPACING = 60;

export function loadTouchLayout(): TouchLayout {
  const raw = lsGet(KEYS.TOUCH_LAYOUT);
  if (!raw) return { ...DEFAULT_TOUCH_LAYOUT };
  try {
    const parsed = JSON.parse(raw) as Partial<TouchLayout>;
    return {
      mirror: parsed.mirror === true,
      scale: clamp(typeof parsed.scale === "number" ? parsed.scale : 1, MIN_SCALE, MAX_SCALE),
      spacing: clamp(typeof parsed.spacing === "number" ? parsed.spacing : 20, MIN_SPACING, MAX_SPACING)
    };
  } catch {
    // Corrupt JSON in storage — fall back to defaults rather than crash.
    return { ...DEFAULT_TOUCH_LAYOUT };
  }
}

export function saveTouchLayout(layout: TouchLayout): void {
  lsSet(KEYS.TOUCH_LAYOUT, JSON.stringify(layout));
}

export function applyTouchLayout(layout: TouchLayout): void {
  const overlay = document.querySelector<HTMLElement>(".gb-touch");
  if (!overlay) return;
  overlay.style.setProperty("--touch-scale", layout.scale.toFixed(2));
  overlay.style.setProperty("--touch-spacing", `${layout.spacing}px`);
  overlay.classList.toggle("is-mirrored", layout.mirror);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
