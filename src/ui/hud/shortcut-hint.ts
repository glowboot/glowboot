import {
  describeButton,
  describeHotkey,
  describeKey,
  GB_BUTTONS,
  HOTKEY_ACTIONS,
  loadHotkeyBindings,
  loadKeyBindings,
  loadShoulderKeyBindings,
  loadTiltBindings
} from "../input/bindings.js";

/**
 * A modal cheat-sheet listing every keyboard shortcut in one place.
 * Summoned with `?` (or whatever `keyboard.ts` is wired to call
 * `toggleShortcutHint` on). Reads the live bindings every time it
 * opens so the labels always reflect what's actually bound — no
 * subscription / re-render dance.
 *
 * The overlay DOM is built lazily on first open and cached for
 * subsequent toggles. Closes on Esc, another toggle, or a click on the
 * backdrop outside the panel.
 */

let overlay: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "shortcut-hint";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Keyboard shortcuts");
  overlay.hidden = true;

  panel = document.createElement("div");
  panel.className = "shortcut-hint-panel";
  overlay.appendChild(panel);

  // Clicking the scrim (but not the panel) closes the overlay.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hide();
  });
  document.body.appendChild(overlay);
  return overlay;
}

function section(title: string, rows: Array<[string, string]>): HTMLElement {
  const s = document.createElement("section");
  const h = document.createElement("h3");
  h.textContent = title;
  s.appendChild(h);
  const dl = document.createElement("dl");
  for (const [label, keys] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = keys;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  s.appendChild(dl);
  return s;
}

function render(): void {
  if (!panel) return;
  panel.innerHTML = "";

  // Header row with a close button, matching the other modals.
  const head = document.createElement("div");
  head.className = "shortcut-hint-head";
  const title = document.createElement("h2");
  title.textContent = "Keyboard shortcuts";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ss-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", hide);
  head.append(title, closeBtn);
  panel.appendChild(head);

  const keys = loadKeyBindings();
  const hot = loadHotkeyBindings();
  const tilt = loadTiltBindings();

  // Joypad — D-Pad shown as a combined cell since its four directions
  // are visually a unit. Face buttons / Start / Select listed
  // individually.
  const dpad =
    describeKey(keys.up) + " " + describeKey(keys.down) + " " + describeKey(keys.left) + " " + describeKey(keys.right);
  panel.appendChild(
    section("Game Boy buttons", [
      ["D-Pad", dpad],
      ...GB_BUTTONS.filter((b) => b !== "up" && b !== "down" && b !== "left" && b !== "right").map(
        (b) => [describeButton(b), describeKey(keys[b])] as [string, string]
      )
    ])
  );

  // GBA shoulders — only meaningful on the GBA engine, but listed
  // unconditionally because the cheat sheet is a keyboard-bindings
  // reference, not a per-cart sheet. Sits above Tilt to mirror the
  // Settings → Controls → Keyboard ordering: L/R applies to most
  // GBA carts; tilt is a small niche.
  const shoulders = loadShoulderKeyBindings();
  panel.appendChild(
    section("GBA shoulders", [
      ["L", describeKey(shoulders.l)],
      ["R", describeKey(shoulders.r)]
    ])
  );

  // Tilt — only meaningful for a handful of carts (MBC7 GB titles +
  // GBA tilt carts), but listed unconditionally for the same reason
  // GBA shoulders are. Combined cell mirrors the D-Pad treatment, in
  // forward/back/left/right order so the row reads like a familiar
  // four-way pad.
  const tiltCell =
    describeKey(tilt.tiltForward) +
    " " +
    describeKey(tilt.tiltBack) +
    " " +
    describeKey(tilt.tiltLeft) +
    " " +
    describeKey(tilt.tiltRight);
  panel.appendChild(section("Tilt", [["Direction", tiltCell]]));

  // Hotkeys — rebindable shell actions.
  panel.appendChild(
    section(
      "Emulator hotkeys",
      HOTKEY_ACTIONS.map((a) => [describeHotkey(a), describeKey(hot[a])] as [string, string])
    )
  );

  // Fixed positional shortcuts — not in the bindings editor.
  panel.appendChild(
    section("Save slots", [
      ["Load slot N", "0 – 9"],
      ["Save slot N", "⇧ + 0 – 9"]
    ])
  );

  const hint = document.createElement("p");
  hint.className = "shortcut-hint-dismiss";
  hint.textContent = "Press ? or Esc to close";
  panel.appendChild(hint);
}

function show(): void {
  const el = ensureOverlay();
  render();
  el.hidden = false;
  document.addEventListener("keydown", onKey, { capture: true });
}

function hide(): void {
  if (!overlay) return;
  overlay.hidden = true;
  document.removeEventListener("keydown", onKey, { capture: true });
}

function onKey(e: KeyboardEvent): void {
  // Esc and `?` (symmetric with the open key) both close the overlay.
  if (e.key === "Escape" || e.key === "?") {
    e.preventDefault();
    e.stopPropagation();
    hide();
  }
}

export function toggleShortcutHint(): void {
  if (overlay && !overlay.hidden) hide();
  else show();
}

// Footer pill — clicking the "? Shortcuts" group opens the overlay,
// giving mouse / trackpad users the same entry point as the keyboard
// `?` shortcut without having to know about it.
document.getElementById("ctrl-shortcut-hint")?.addEventListener("click", () => {
  toggleShortcutHint();
});
