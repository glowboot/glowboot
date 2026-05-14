/**
 * Screen-reader-only live region. Announces transient session events
 * (pause/resume, speed change, rewind start/end, frame advance) that
 * are visible via status-strip text or overlays but don't currently
 * reach an `aria-live` region.
 *
 * Separate from the toast channel so these announcements don't add
 * visual noise — the visual indicators already exist. The element
 * is `.sr-only` so sighted users never see it, but the `aria-live`
 * attribute causes assistive tech to speak the textContent whenever
 * it changes.
 */

let srEl: HTMLElement | null = null;

function ensure(): HTMLElement {
  if (srEl) return srEl;
  srEl = document.createElement("div");
  srEl.id = "sr-announce";
  srEl.className = "sr-only";
  srEl.setAttribute("role", "status");
  srEl.setAttribute("aria-live", "polite");
  document.body.appendChild(srEl);
  return srEl;
}

export function announce(msg: string): void {
  const el = ensure();
  // Setting the same text twice in a row doesn't always re-trigger
  // announcement; clearing first forces the reader to see it as new.
  if (el.textContent === msg) el.textContent = "";
  el.textContent = msg;
}
