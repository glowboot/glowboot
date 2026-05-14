/**
 * Collapsible settings sections. Clicking the `<h4>` header of a section
 * toggles its body. Open/closed state persists per section name (via the
 * `data-section` attribute) so the user's layout preferences survive
 * reloads.
 *
 * Defaults: everything except Display starts collapsed — Display holds
 * the theme/rendering/palette/grading knobs most users touch first, so
 * opening Settings lands on something useful. Palette + grading used
 * to be their own sections; they now live inside Display.
 *
 * Storage is a single JSON object under `gb-settings-collapsed` rather
 * than one key per section so the preferences export stays tidy.
 */

import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";

const DEFAULT_COLLAPSED: Record<string, boolean> = {
  // Display starts open — most users adjust render mode / palette /
  // colour grading first when they pop the popover. Everything else
  // starts collapsed so the menu stays scannable.
  keyboard: true,
  hotkeys: true,
  gamepad: true,
  touch: true,
  audio: true,
  behavior: true,
  backup: true
};

function loadState(): Record<string, boolean> {
  const raw = lsGet(KEYS.SETTINGS_COLLAPSED);
  if (!raw) return { ...DEFAULT_COLLAPSED };
  try {
    return { ...DEFAULT_COLLAPSED, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_COLLAPSED };
  }
}

function saveState(state: Record<string, boolean>): void {
  lsSet(KEYS.SETTINGS_COLLAPSED, JSON.stringify(state));
}

const state = loadState();

for (const section of document.querySelectorAll<HTMLElement>(".settings-section[data-section]")) {
  const name = section.dataset.section;
  if (!name) continue;
  if (state[name]) section.classList.add("collapsed");

  const header = section.querySelector<HTMLElement>("h4");
  if (!header) continue;
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", state[name] ? "false" : "true");

  const toggle = (): void => {
    const collapsed = section.classList.toggle("collapsed");
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    state[name] = collapsed;
    saveState(state);
  };

  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
}
