import { cheatsPop } from "../dom.js";
import { closeCartInfo, closeCheats, closeRecents, closeSettings, closeSlots, openCheats } from "../popovers";
import { resetCart } from "../rom-loader.js";
import { cycleSpeed, takeScreenshot, togglePause, toggleRecording, translateScreen } from "../session/actions.js";
import { endRewind, startRewind } from "../session/rewind.js";

/**
 * Tap dispatcher for runtime actions on touch devices. The `.touch-
 * actions` toolbar below the canvas (icon-only round buttons, see
 * index.html) is the primary surface; this module wires each button's
 * `data-touch-action` attribute to its session-action handler.
 *
 * Save / load slot aren't exposed here — they need a slot number that
 * a single tap can't supply, and the Slots popover header icon already
 * covers those paths. Rewind is the one button that wants press-and-
 * hold (matches the keyboard Backspace bind), so it's wired with
 * pointer events at the bottom of this module; everything else
 * dispatches via a plain click.
 */

function dispatch(action: string): void {
  switch (action) {
    case "pause":
      void togglePause();
      return;
    case "turbo":
      cycleSpeed();
      return;
    case "screenshot":
      void takeScreenshot();
      return;
    case "record":
      toggleRecording();
      return;
    case "translate":
      translateScreen();
      return;
    case "reset":
      void resetCart();
      return;
    case "cheats":
      if (cheatsPop?.classList.contains("open")) {
        closeCheats();
      } else {
        closeRecents();
        closeSlots();
        closeSettings();
        closeCartInfo();
        openCheats();
      }
      return;
    // "rewind" is hold-only; no meaningful tap semantics.
  }
}

// Wire the new touch-actions toolbar — primary path on phones / tablets.
// Rewind is special: it's a press-and-hold gesture (matches the keyboard
// Backspace bind), so pointerdown starts the scrub and pointerup ends
// it. Everything else dispatches on a normal tap.
for (const el of document.querySelectorAll<HTMLElement>(".touch-action[data-touch-action]")) {
  const action = el.dataset.touchAction;
  if (!action) continue;
  if (action === "rewind") {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      el.classList.add("is-pressed");
      startRewind();
    });
    const release = (e: PointerEvent): void => {
      el.classList.remove("is-pressed");
      void endRewind();
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    continue;
  }
  el.addEventListener("click", () => dispatch(action));
}
