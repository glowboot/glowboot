import { inTextInput, inUiControl, slotFromCode } from "../format.js";
import { toggleShortcutHint } from "../hud/shortcut-hint.js";
import { doLoadState, doSaveState } from "../popovers";
import { resetCart } from "../rom-loader.js";
import { cycleSpeed, takeScreenshot, togglePause, toggleRecording, translateScreen } from "../session/actions.js";
import { endRewind, startRewind } from "../session/rewind.js";
import * as BindingsUI from "../settings";
import { state } from "../state.js";

/**
 * Global keyboard routing:
 *   - digit 0-9 (plain / Shift) → save-state slots
 *   - bound hotkeys (pause / turbo / rewind / screenshot / record / reset)
 *   - anything that matches a bound joypad button (the eight shared
 *     D-pad + A/B/Start/Select keys) → the active engine's joypad
 *   - GBA-only shoulders L / R → `state.gba.joypad` when a GBA cart
 *     is loaded; ignored under a GB cart so the same key can stay
 *     bound across sessions without surprises
 *
 * Hotkeys are intentionally limited to in-game actions. Popover-opening
 * shortcuts (Settings / Library / Slots / Cheats / Debugger / Printer)
 * all use their header icons. Debugger-internal step actions (Frame /
 * Step / Rewind 1 s) live on the debugger's own control bar — they
 * only make sense with the debugger pane visible, where you can see
 * what the step did.
 *
 * We intentionally yield to text inputs (cheat-code form, etc.) so the
 * user can type without the emulator stealing their keystrokes, and we
 * skip OS modifier combos (Ctrl / Cmd / Alt) so shortcuts like ⌘R still
 * reload the page. Hotkey mapping is re-read on every event via the
 * live-binding export from `../settings/bindings.ts`, so rebinds apply
 * immediately.
 */

function dispatchHotkey(action: string, e: KeyboardEvent): boolean {
  switch (action) {
    case "screenshot":
      e.preventDefault();
      takeScreenshot();
      return true;
    case "translate":
      e.preventDefault();
      translateScreen();
      return true;
    case "record":
      e.preventDefault();
      toggleRecording();
      return true;
    case "reset":
      e.preventDefault();
      void resetCart();
      return true;
    case "pause":
      e.preventDefault();
      void togglePause();
      return true;
    case "turbo":
      e.preventDefault();
      // Holding Shift reverses the cycle so the user can step down from
      // 4× → 2× without walking around through 0.5× first.
      if (!e.repeat) cycleSpeed(e.shiftKey ? -1 : 1);
      return true;
    case "rewind":
      e.preventDefault();
      if (!e.repeat) startRewind();
      return true;
  }
  return false;
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (inTextInput(e)) return;
  // Yield every keystroke when focus is on an interactive UI element —
  // header buttons, popover buttons, links, custom radio groups, etc.
  // Without this, arrows press the D-pad and Space pauses instead of
  // activating the focused button — both break native keyboard
  // navigation. The emulator regains every key once focus is on the
  // canvas (playing surface) or implicit on body.
  if (inUiControl(e)) return;

  // `?` summons the keyboard-shortcut cheat sheet — conventional web
  // app help key. Handled before the slot/hotkey routing since `?` is
  // Shift+Slash on US layouts and would otherwise trip no-op cases.
  if (e.key === "?") {
    e.preventDefault();
    toggleShortcutHint();
    return;
  }

  // Numeric slots: plain digit = load, Shift+digit = save.
  const slot = slotFromCode(e.code);
  if (slot !== null) {
    e.preventDefault();
    if (e.shiftKey) void doSaveState(slot);
    else void doLoadState(slot);
    return;
  }

  const action = BindingsUI.codeToHotkey[e.code];
  if (action && dispatchHotkey(action, e)) return;

  // Joypad — fall through to last. Dispatch to whichever engine is
  // active (only one of state.gb / state.gba is non-null at a time).
  const btn = BindingsUI.codeToButton[e.code];
  if (btn) {
    e.preventDefault();
    state.gb?.joypad.press(btn);
    state.gba?.joypad.press(btn);
  }

  // GBA shoulders — only meaningful when a GBA cart is loaded. The key
  // routing happens after GB-button dispatch so a code bound to both
  // (e.g. user deliberately overlapped) still feeds the engine that
  // can use either.
  const shoulder = BindingsUI.codeToShoulder[e.code];
  if (shoulder && state.gba) {
    e.preventDefault();
    state.gba.joypad.press(shoulder);
  }
});

window.addEventListener("keyup", (e) => {
  if (inTextInput(e)) return;
  if (inUiControl(e)) return;
  const action = BindingsUI.codeToHotkey[e.code];
  // Speed/turbo is a tap-to-cycle toggle, so there's no keyup half —
  // releasing the bound key leaves the emulator at whatever multiplier
  // the last tap selected. Rewind is still hold-to-scrub.
  if (action === "rewind") {
    e.preventDefault();
    void endRewind();
    return;
  }
  const btn = BindingsUI.codeToButton[e.code];
  if (btn) {
    e.preventDefault();
    state.gb?.joypad.release(btn);
    state.gba?.joypad.release(btn);
  }
  const shoulder = BindingsUI.codeToShoulder[e.code];
  if (shoulder && state.gba) {
    e.preventDefault();
    state.gba.joypad.release(shoulder);
  }
});
