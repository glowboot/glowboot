import type { Button } from "../../gb";
import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";
import type { ShoulderButton } from "./bindings.js";
import type { JoypadHost, ShoulderHost } from "./gamepad.js";
import { safeVibrate } from "./haptic.js";

/** Short pulse fired on every fresh GB-button press from the touch
 *  overlay — gives virtual buttons the click-confirm feel that
 *  physical hardware has for free. 8 ms is short enough not to feel
 *  buzzy but long enough that a thumb actually senses the kick.
 *  Skipped silently on platforms without `navigator.vibrate` (iOS
 *  Safari), pre-activation (see `safeVibrate`), and when the user has
 *  switched off Settings → Controls → Touch → Press feedback. */
const PRESS_HAPTIC_MS = 8;

/** Read the stored opt-out on each press. localStorage is microsecond-
 *  fast and the press rate (~10 taps/sec at peak) is far below where
 *  caching would matter — but it does mean toggling the setting takes
 *  effect immediately, no reload needed. */
function pressHaptic(): void {
  if (lsGet(KEYS.TOUCH_PRESS_HAPTIC) === "0") return;
  safeVibrate(PRESS_HAPTIC_MS);
}

/**
 * On-screen touch controls for phones / tablets. Authors an overlay
 * that sits below the canvas in normal view and is re-pinned to the
 * bottom of the viewport when the browser enters fullscreen. Serves
 * both engines: the eight shared buttons are always wired, plus
 * `.gb-btn-l` / `.gb-btn-r` for Game Boy Advance shoulders (hidden by
 * CSS until `body.is-gba` is set by the GBA runtime).
 *
 * The overlay element (and its children `.gb-dpad`, `.gb-btn-a`,
 * `.gb-btn-b`, `.gb-btn-start`, `.gb-btn-select`, plus the GBA-only
 * `.gb-btn-l` / `.gb-btn-r`) must already be in the DOM — this module
 * only wires pointer events and applies / removes `.gb-touch--on`
 * based on the user's mode preference.
 *
 * Three visibility modes: `auto` (shown when a coarse pointer is the
 * primary input), `on` (always shown), `off` (never shown).
 */

export type TouchMode = "auto" | "on" | "off";

/** Auto visibility = primary pointer is coarse (finger). Dropping the
 *  narrow-viewport clause keeps the touch overlay off of resized desktop
 *  windows and restricts it to actually touch-driven devices. */
const AUTO_QUERY = "(pointer: coarse)";

// Toggle a `body.is-touch` class that CSS and other modules can target
// to know "this is a touch device". Updates live on device / pointer
// changes (hybrid laptops toggle between coarse and fine).
{
  const bodyMq = window.matchMedia(AUTO_QUERY);
  const sync = (): void => {
    document.body.classList.toggle("is-touch", bodyMq.matches);
  };
  sync();
  bodyMq.addEventListener("change", sync);
}

export function loadTouchMode(): TouchMode {
  const v = lsGet(KEYS.TOUCH_MODE);
  if (v === "on" || v === "off" || v === "auto") return v;
  return "auto";
}

export function saveTouchMode(m: TouchMode): void {
  lsSet(KEYS.TOUCH_MODE, m);
}

/** Landscape behaviour on touch devices. `portrait` is the historical
 *  behaviour (rotate-prompt overlay covers the screen until the user
 *  rotates); the other three are the new in-landscape layouts. CSS in
 *  `touch.css` keys off `body[data-landscape-layout="..."]` to switch
 *  between them. */
export type TouchLandscapeLayout = "portrait" | "flank" | "overlay" | "reveal";

const LANDSCAPE_LAYOUTS: readonly TouchLandscapeLayout[] = ["portrait", "flank", "overlay", "reveal"];

/** `flank` is the default because rotating the device should make
 *  landscape just work, not pop a "rotate to portrait" overlay. Side-
 *  gutter controls + native-aspect canvas is the layout that reads as
 *  "real handheld" of the three. Users who want the historical portrait
 *  behaviour can pick "Force portrait" in Settings → Controls → Touch
 *  → Landscape layout. */
export const DEFAULT_TOUCH_LANDSCAPE_LAYOUT: TouchLandscapeLayout = "flank";

export function loadTouchLandscapeLayout(): TouchLandscapeLayout {
  const v = lsGet(KEYS.TOUCH_LANDSCAPE_LAYOUT);
  if (v && (LANDSCAPE_LAYOUTS as readonly string[]).includes(v)) return v as TouchLandscapeLayout;
  return DEFAULT_TOUCH_LANDSCAPE_LAYOUT;
}

export function saveTouchLandscapeLayout(layout: TouchLandscapeLayout): void {
  lsSet(KEYS.TOUCH_LANDSCAPE_LAYOUT, layout);
}

/** Apply the chosen layout to `<body>` so CSS can pick it up. Read by
 *  the `body[data-landscape-layout="..."]` selectors in `touch.css` and
 *  `base.css` (the rotate-prompt overlay is gated on `portrait`). */
export function applyTouchLandscapeLayout(layout: TouchLandscapeLayout): void {
  document.body.dataset.landscapeLayout = layout;
}

/** Tap-to-reveal listener. When the canvas is tapped in landscape +
 *  `data-landscape-layout=reveal`, add `body.touch-reveal-show` for
 *  `REVEAL_MS` so the controls fade in. Idempotent — installs once on
 *  first call. CSS gates the actual visibility; the listener fires
 *  unconditionally and the class is a no-op in other layouts.
 *
 *  Listens on both `.canvas-wrap` AND `.gb-touch` so the timer resets
 *  whenever the user is actively interacting — without that, holding a
 *  d-pad direction past REVEAL_MS would fade the controls out under
 *  the user's finger. */
const REVEAL_MS = 2400;
let revealInstalled = false;
let revealTimer: number | null = null;
export function installTouchRevealListener(): void {
  if (revealInstalled) return;
  const canvasWrap = document.querySelector<HTMLElement>(".canvas-wrap");
  const touchOverlay = document.querySelector<HTMLElement>(".gb-touch");
  if (!canvasWrap) return;
  const show = (): void => {
    document.body.classList.add("touch-reveal-show");
    if (revealTimer !== null) clearTimeout(revealTimer);
    revealTimer = window.setTimeout(() => {
      document.body.classList.remove("touch-reveal-show");
      revealTimer = null;
    }, REVEAL_MS);
  };
  canvasWrap.addEventListener("pointerdown", show, { passive: true });
  touchOverlay?.addEventListener("pointerdown", show, { passive: true });
  revealInstalled = true;
}

export interface TouchControls {
  setMode(m: TouchMode): void;
  destroy(): void;
}

/** 8-way bucket → which directional button(s) to press. Index 0 is East,
 *  incrementing counter-clockwise (45° steps). */
const DIR_BUTTONS: readonly (readonly Button[])[] = [
  ["right"],
  ["right", "up"],
  ["up"],
  ["up", "left"],
  ["left"],
  ["left", "down"],
  ["down"],
  ["down", "right"]
];
const DIR_CLASSES: readonly ("up" | "down" | "left" | "right")[] = ["up", "down", "left", "right"];

export function initTouchControls(
  getJoypad: () => JoypadHost | null,
  getShoulderHost: () => ShoulderHost | null,
  root: HTMLElement
): TouchControls {
  const dpad = root.querySelector<HTMLElement>(".gb-dpad");
  const btnA = root.querySelector<HTMLElement>(".gb-btn-a");
  const btnB = root.querySelector<HTMLElement>(".gb-btn-b");
  const btnStart = root.querySelector<HTMLElement>(".gb-btn-start");
  const btnSelect = root.querySelector<HTMLElement>(".gb-btn-select");
  const btnL = root.querySelector<HTMLElement>(".gb-btn-l");
  const btnR = root.querySelector<HTMLElement>(".gb-btn-r");

  // ─── D-pad: continuous vector → 8-way direction ──────────────────────────
  // A single pointer controls the D-pad at a time. `setPointerCapture` keeps
  // events flowing to this element even when the finger slides beyond the
  // pad's bounding box, so diagonal swipes don't lose tracking.
  const dpadPressed = new Set<Button>();
  let dpadPointerId: number | null = null;

  const updateDpadFromPointer = (clientX: number, clientY: number): void => {
    if (!dpad) return;
    const rect = dpad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const radius = Math.min(rect.width, rect.height) / 2;
    const deadzone = radius * 0.18;
    const mag = Math.hypot(dx, dy);

    const next = new Set<Button>();
    if (mag > deadzone) {
      // Flip y so positive angle = up (screen coords have y growing downward).
      const angle = Math.atan2(-dy, dx);
      const twoPi = Math.PI * 2;
      const wrapped = ((angle % twoPi) + twoPi) % twoPi;
      const idx = Math.round(wrapped / (Math.PI / 4)) % 8;
      const buttons = DIR_BUTTONS[idx];
      if (buttons) for (const b of buttons) next.add(b);
    }

    // Diff against previous frame so we issue only the changes.
    const joy = getJoypad();
    for (const b of dpadPressed) if (!next.has(b)) joy?.release(b);
    for (const b of next) {
      if (dpadPressed.has(b)) continue;
      joy?.press(b);
      pressHaptic();
    }
    dpadPressed.clear();
    for (const b of next) dpadPressed.add(b);

    for (const dir of DIR_CLASSES) {
      dpad.classList.toggle(`is-pressed-${dir}`, dpadPressed.has(dir as Button));
    }
  };

  const onDpadDown = (e: PointerEvent): void => {
    if (!dpad || dpadPointerId !== null) return;
    dpadPointerId = e.pointerId;
    try {
      dpad.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    updateDpadFromPointer(e.clientX, e.clientY);
  };
  const onDpadMove = (e: PointerEvent): void => {
    if (dpadPointerId !== e.pointerId) return;
    updateDpadFromPointer(e.clientX, e.clientY);
  };
  const onDpadUp = (e: PointerEvent): void => {
    if (!dpad || dpadPointerId !== e.pointerId) return;
    dpadPointerId = null;
    const joy = getJoypad();
    for (const b of dpadPressed) joy?.release(b);
    dpadPressed.clear();
    for (const dir of DIR_CLASSES) dpad.classList.remove(`is-pressed-${dir}`);
    try {
      dpad.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  if (dpad) {
    dpad.addEventListener("pointerdown", onDpadDown);
    dpad.addEventListener("pointermove", onDpadMove);
    dpad.addEventListener("pointerup", onDpadUp);
    dpad.addEventListener("pointercancel", onDpadUp);
  }

  // ─── Discrete buttons ────────────────────────────────────────────────────
  // Two wiring paths:
  //   * A + B share a group handler (`.gb-ab`) that hit-tests on every
  //     pointermove so a single thumb rolling between B and A registers
  //     each press correctly. The per-button setPointerCapture pattern
  //     (used for Start/Select below) traps all events on whichever
  //     button got pointerdown — fine for taps, but it makes the
  //     classic Mario "hold B, occasional A" combo impossible with one
  //     thumb because A never sees a pointerdown.
  //   * Start / Select keep the simple per-button capture handler — no
  //     slide-between use case there, and the system pills sit far
  //     enough apart that a single finger can't span both.

  interface ButtonHandles {
    down: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
  }
  const wires: Array<{ el: HTMLElement; handles: ButtonHandles }> = [];

  // Hit-zone inflation so a thumb hovering near the seam between B
  // and A registers *both* presses for a frame or two — mirrors how
  // real DMG hardware feels when the thumb covers the boundary. With
  // the 10 px CSS gap between A and B (touch.css), 22 px inflation
  // produces a 34 px-wide "both pressed" overlap zone — wide enough
  // that a quick run-then-jump roll (Mario hold-B + tap-A) reliably
  // crosses both buttons during the transition without being so
  // sticky that a tap on one accidentally triggers the other.
  const HIT_INFLATE_PX = 22;

  type AbButton = "a" | "b";
  const buttonsUnderPointer = (clientX: number, clientY: number): Set<AbButton> => {
    const out = new Set<AbButton>();
    const hit = (el: HTMLElement | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        clientX >= r.left - HIT_INFLATE_PX &&
        clientX <= r.right + HIT_INFLATE_PX &&
        clientY >= r.top - HIT_INFLATE_PX &&
        clientY <= r.bottom + HIT_INFLATE_PX
      );
    };
    if (hit(btnA)) out.add("a");
    if (hit(btnB)) out.add("b");
    return out;
  };

  const elFor = (b: AbButton): HTMLElement | null => (b === "a" ? btnA : btnB);

  const wireAbGroup = (): {
    down: (e: PointerEvent) => void;
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
  } | null => {
    const group = root.querySelector<HTMLElement>(".gb-ab");
    if (!group || (!btnA && !btnB)) return null;

    // Per-pointer set of currently-pressed buttons. Multi-touch friendly:
    // each finger maintains its own set, so two thumbs can hold B and A
    // simultaneously and they don't fight over the press state.
    const pointerState = new Map<number, Set<AbButton>>();

    const updateForPointer = (pointerId: number, clientX: number, clientY: number): void => {
      const next = buttonsUnderPointer(clientX, clientY);
      const prev = pointerState.get(pointerId) ?? new Set<AbButton>();
      const joy = getJoypad();

      // Released: any button this pointer used to be on but isn't now.
      // Only release on the joypad if no *other* active pointer is also
      // pressing it (multi-touch case).
      for (const b of prev) {
        if (next.has(b)) continue;
        const stillHeldByOther = [...pointerState].some(([pid, s]) => pid !== pointerId && s.has(b));
        if (!stillHeldByOther) {
          joy?.release(b as Button);
          elFor(b)?.classList.remove("is-pressed");
        }
      }
      // Newly pressed: any button this pointer just slid onto.
      for (const b of next) {
        if (prev.has(b)) continue;
        const alreadyHeldByOther = [...pointerState].some(([pid, s]) => pid !== pointerId && s.has(b));
        if (!alreadyHeldByOther) {
          joy?.press(b as Button);
          pressHaptic();
        }
        elFor(b)?.classList.add("is-pressed");
      }

      if (next.size === 0) pointerState.delete(pointerId);
      else pointerState.set(pointerId, next);
    };

    const releasePointer = (pointerId: number): void => {
      const state = pointerState.get(pointerId);
      if (!state) return;
      pointerState.delete(pointerId);
      const joy = getJoypad();
      for (const b of state) {
        const stillHeldByOther = [...pointerState].some(([, s]) => s.has(b));
        if (!stillHeldByOther) {
          joy?.release(b as Button);
          elFor(b)?.classList.remove("is-pressed");
        }
      }
    };

    const down = (e: PointerEvent): void => {
      // Only react if the down lands within the group's hit zone — clicks
      // that bubble up from outside (e.g. on parent layout elements) are
      // ignored.
      const buttons = buttonsUnderPointer(e.clientX, e.clientY);
      if (buttons.size === 0) return;
      try {
        group.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
      updateForPointer(e.pointerId, e.clientX, e.clientY);
    };
    const move = (e: PointerEvent): void => {
      if (!pointerState.has(e.pointerId)) return;
      updateForPointer(e.pointerId, e.clientX, e.clientY);
    };
    const up = (e: PointerEvent): void => {
      if (!pointerState.has(e.pointerId)) return;
      releasePointer(e.pointerId);
      try {
        group.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    group.addEventListener("pointerdown", down);
    group.addEventListener("pointermove", move);
    group.addEventListener("pointerup", up);
    group.addEventListener("pointercancel", up);

    return { down, move, up };
  };
  const abHandles = wireAbGroup();

  const wireButton = (el: HTMLElement | null, btn: Button): void => {
    if (!el) return;
    let pid: number | null = null;
    const down = (e: PointerEvent): void => {
      if (pid !== null) return;
      pid = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      el.classList.add("is-pressed");
      e.preventDefault();
      getJoypad()?.press(btn);
      pressHaptic();
    };
    const up = (e: PointerEvent): void => {
      if (pid !== e.pointerId) return;
      pid = null;
      el.classList.remove("is-pressed");
      getJoypad()?.release(btn);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    wires.push({ el, handles: { down, up } });
  };
  wireButton(btnStart, "start");
  wireButton(btnSelect, "select");

  // GBA shoulder buttons. Wired against the shoulder host (which the
  // rom-loader binds to a running GBA cart's joypad). Hidden via CSS
  // unless `body.is-gba` is present, so taps from a stale layout when
  // no GBA cart is loaded both fall on a hidden element and silently
  // no-op if a pointer manages to land on them.
  const wireShoulder = (el: HTMLElement | null, btn: ShoulderButton): void => {
    if (!el) return;
    let pid: number | null = null;
    const down = (e: PointerEvent): void => {
      if (pid !== null) return;
      pid = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      el.classList.add("is-pressed");
      e.preventDefault();
      getShoulderHost()?.press(btn);
      pressHaptic();
    };
    const up = (e: PointerEvent): void => {
      if (pid !== e.pointerId) return;
      pid = null;
      el.classList.remove("is-pressed");
      getShoulderHost()?.release(btn);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    wires.push({ el, handles: { down, up } });
  };
  wireShoulder(btnL, "l");
  wireShoulder(btnR, "r");

  // ─── Visibility ─────────────────────────────────────────────────────────
  const mq = window.matchMedia(AUTO_QUERY);
  let mode: TouchMode = "auto";

  const apply = (): void => {
    const shown = mode === "on" || (mode === "auto" && mq.matches);
    // `.gb-touch--on` only matters on fine-pointer devices when the user
    // explicitly chose On; the `(pointer: coarse)` media query in
    // touch.css covers the default Auto + coarse-pointer case at first
    // paint. `.gb-touch--off` is the explicit hide that overrides that
    // default. Splitting the two avoids the JS-driven class addition
    // shifting layout post-paint.
    root.classList.toggle("gb-touch--on", mode === "on");
    root.classList.toggle("gb-touch--off", mode === "off");
    root.setAttribute("aria-hidden", shown ? "false" : "true");
  };

  const onMqChange = (): void => apply();
  mq.addEventListener("change", onMqChange);

  return {
    setMode(m: TouchMode): void {
      mode = m;
      apply();
    },
    destroy(): void {
      mq.removeEventListener("change", onMqChange);
      if (dpad) {
        dpad.removeEventListener("pointerdown", onDpadDown);
        dpad.removeEventListener("pointermove", onDpadMove);
        dpad.removeEventListener("pointerup", onDpadUp);
        dpad.removeEventListener("pointercancel", onDpadUp);
      }
      const abGroup = root.querySelector<HTMLElement>(".gb-ab");
      if (abGroup && abHandles) {
        abGroup.removeEventListener("pointerdown", abHandles.down);
        abGroup.removeEventListener("pointermove", abHandles.move);
        abGroup.removeEventListener("pointerup", abHandles.up);
        abGroup.removeEventListener("pointercancel", abHandles.up);
      }
      for (const { el, handles } of wires) {
        el.removeEventListener("pointerdown", handles.down);
        el.removeEventListener("pointerup", handles.up);
        el.removeEventListener("pointercancel", handles.up);
      }
    }
  };
}
