import { audioPane } from "../debugger/audio-pane.js";
import { breakpointsPane } from "../debugger/breakpoints-pane.js";
import { callStackPane } from "../debugger/callstack-pane.js";
import { cpuPane } from "../debugger/cpu-pane.js";
import { disasmPane, scrollDisasmToPc } from "../debugger/disasm-pane.js";
import { memoryPane } from "../debugger/memory-pane.js";
import { palettePane } from "../debugger/palette-pane.js";
import type { Pane } from "../debugger/pane.js";
import { symbolsPane } from "../debugger/symbols-pane.js";
import { tilePane } from "../debugger/tile-pane.js";
import { debuggerPop, debuggerTrigger } from "../dom.js";
import { frameAdvance, stepFrameBack, stepInstruction, togglePause } from "../session/actions.js";
import { state } from "../state.js";

/**
 * Debugger popover — tabbed inspector with a play/pause/step control
 * bar along the bottom. Panes cover CPU registers, the memory map
 * (with editor + watchpoints), live disassembly with PC tracking and
 * a breakpoint gutter, palette + tile viewers, audio scopes, the
 * synthesised call stack, and an `.sym`-loaded symbols pane.
 *
 * Persistence: active-tab choice survives page reloads (sessionStorage)
 * so the user lands back where they were last looking.
 *
 * Lifecycle: the pane DOM is built once the first time a pane becomes
 * active (Pane.mount). Subsequent visibility toggles hide/show without
 * tearing down. Refresh runs on rAF while the popover is open, calling
 * only the active pane's `refresh` to keep work bounded.
 */

const PANES: readonly Pane[] = [
  cpuPane,
  disasmPane,
  memoryPane,
  palettePane,
  tilePane,
  audioPane,
  breakpointsPane,
  callStackPane,
  symbolsPane
];
const ACTIVE_TAB_KEY = "gb-debugger-active-tab";

interface MountedPane {
  pane: Pane;
  container: HTMLElement;
  mounted: boolean;
}

interface ControlRefs {
  playPause: HTMLButtonElement;
  stepInstr: HTMLButtonElement;
  stepFrame: HTMLButtonElement;
  stepBack: HTMLButtonElement;
  status: HTMLElement;
}

let mountedPanes: MountedPane[] = [];
let activeId: string = PANES[0]!.id;
let refreshRaf = 0;
let built = false;
let controlRefs: ControlRefs | null = null;

export function openDebugger(): void {
  if (!debuggerPop) return;
  if (!built) build();
  debuggerPop.classList.add("open");
  debuggerTrigger?.setAttribute("aria-expanded", "true");
  // Auto-pause on open so live CPU / memory / audio values aren't a
  // blur. The user can press Space or click ▶ to resume if they want
  // to watch state evolve.
  if (state.gb && !state.paused) void togglePause();
  startRefreshLoop();
}

export function closeDebugger(): void {
  debuggerPop?.classList.remove("open");
  debuggerTrigger?.setAttribute("aria-expanded", "false");
  stopRefreshLoop();
}

/** Tablet + phone viewports hide the debugger trigger via CSS (see
 *  popovers.css `@media (max-width: 720px)`). The popover itself
 *  still works at narrow widths via the More menu, but a desktop user
 *  who resizes from wide → narrow with the debugger open ends up
 *  staring at hex tables crammed into a phone-width modal. Auto-close
 *  on cross-threshold resize so they get a clean state instead; they
 *  can reopen via the More menu if they actually want it there. */
const NARROW_BREAKPOINT_PX = 720;
window.addEventListener("resize", () => {
  if (window.innerWidth <= NARROW_BREAKPOINT_PX && debuggerPop?.classList.contains("open")) {
    closeDebugger();
  }
});

function build(): void {
  if (!debuggerPop) return;
  debuggerPop.innerHTML = "";

  const layout = document.createElement("div");
  layout.className = "debugger-layout";

  // Left: tab strip. role=tablist lets assistive tech announce this as
  // a tab widget; arrow keys between tabs are wired below.
  const tabStrip = document.createElement("div");
  tabStrip.className = "debugger-tabs";
  tabStrip.setAttribute("role", "tablist");
  tabStrip.setAttribute("aria-orientation", "horizontal");
  // Right: active pane host.
  const paneHost = document.createElement("div");
  paneHost.className = "debugger-pane-host";

  mountedPanes = PANES.map((pane) => {
    const container = document.createElement("div");
    container.className = "debugger-pane-container";
    container.id = `debugger-panel-${pane.id}`;
    container.setAttribute("role", "tabpanel");
    container.setAttribute("aria-labelledby", `debugger-tab-${pane.id}`);
    container.hidden = true;
    paneHost.appendChild(container);

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "debugger-tab";
    tab.id = `debugger-tab-${pane.id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `debugger-panel-${pane.id}`);
    tab.setAttribute("aria-selected", "false");
    tab.tabIndex = -1;
    tab.textContent = pane.label;
    tab.dataset.paneId = pane.id;
    tab.addEventListener("click", () => setActive(pane.id));
    tabStrip.appendChild(tab);

    return { pane, container, mounted: false };
  });

  // Arrow-key navigation between tabs — standard tab-widget pattern.
  // ←/→ walk the strip, Home/End jump to the extremes. Focus moves
  // and the tab activates (same click-gesture behaviour); the roving
  // `tabIndex` is updated so Tab into/out-of the widget lands on the
  // currently-active tab, not the first one.
  tabStrip.addEventListener("keydown", (e) => {
    const key = e.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    e.preventDefault();
    const ids = PANES.map((p) => p.id);
    const idx = ids.indexOf(activeId);
    let next = idx;
    if (key === "ArrowLeft") next = (idx - 1 + ids.length) % ids.length;
    else if (key === "ArrowRight") next = (idx + 1) % ids.length;
    else if (key === "Home") next = 0;
    else if (key === "End") next = ids.length - 1;
    setActive(ids[next]!);
    const newTab = tabStrip.querySelector<HTMLButtonElement>(`[data-pane-id="${ids[next]}"]`);
    newTab?.focus();
  });

  layout.append(tabStrip, paneHost);
  debuggerPop.appendChild(layout);

  debuggerPop.appendChild(buildControls());

  // Flip `built` before the first `setActive` — the guard inside that
  // function bails when `!built`, so calling it before would silently
  // skip the initial tab activation and leave every pane hidden.
  built = true;

  const stored = sessionStorage.getItem(ACTIVE_TAB_KEY);
  const initial = stored && PANES.some((p) => p.id === stored) ? stored : PANES[0]!.id;
  setActive(initial);
}

function buildControls(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "debugger-controls";

  // Every control-bar action also re-anchors the disasm view on PC
  // so the user's scroll position follows the step. `scrollDisasmToPc`
  // is a no-op on panes other than disasm, so it's cheap to call
  // unconditionally.
  const afterAction = (): void => {
    refreshActive();
    scrollDisasmToPc();
  };

  // Label is rewritten on every `updateStatus` tick to reflect the
  // current pause state — the button shows the action the user would
  // take next, not both glyphs. Initial label is a placeholder.
  const playPause = ctrlBtn("▶", "Play / Pause (Space)", () => {
    void togglePause().then(afterAction);
  });
  const stepInstr = ctrlBtn("Step", "Step one CPU instruction", () => {
    stepInstruction();
    afterAction();
  });
  const stepFrame = ctrlBtn("Frame", "Advance one full frame", () => {
    frameAdvance();
    afterAction();
  });
  const stepBack = ctrlBtn("Rewind", "Rewind one snapshot ≈ 1 s (Backspace is hold-to-rewind)", () => {
    stepFrameBack();
    afterAction();
  });

  const status = document.createElement("span");
  status.className = "debugger-status";
  // Status text is written by the refresh loop so it stays live.
  status.textContent = "";

  bar.append(playPause, stepInstr, stepFrame, stepBack, status);

  controlRefs = { playPause, stepInstr, stepFrame, stepBack, status };

  return bar;
}

function ctrlBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "debugger-ctrl";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function setActive(id: string): void {
  if (!built) return;
  activeId = id;
  try {
    sessionStorage.setItem(ACTIVE_TAB_KEY, id);
  } catch {
    /* ignore */
  }
  for (const mp of mountedPanes) {
    const isActive = mp.pane.id === id;
    mp.container.hidden = !isActive;
    if (isActive && !mp.mounted) {
      mp.pane.mount(mp.container);
      mp.mounted = true;
    }
  }
  if (!debuggerPop) return;
  for (const tab of debuggerPop.querySelectorAll<HTMLButtonElement>(".debugger-tab")) {
    const isActive = tab.dataset.paneId === id;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
    // Roving tabindex: only the active tab participates in the
    // document's Tab sequence. Arrow keys (above) handle movement
    // between tabs once focus is inside the strip.
    tab.tabIndex = isActive ? 0 : -1;
  }
}

function startRefreshLoop(): void {
  if (refreshRaf) return;
  const tick = (): void => {
    if (!debuggerPop?.classList.contains("open")) {
      refreshRaf = 0;
      return;
    }
    refreshActive();
    updateStatus();
    refreshRaf = requestAnimationFrame(tick);
  };
  refreshRaf = requestAnimationFrame(tick);
}

function stopRefreshLoop(): void {
  if (refreshRaf) cancelAnimationFrame(refreshRaf);
  refreshRaf = 0;
}

function refreshActive(): void {
  const mp = mountedPanes.find((m) => m.pane.id === activeId);
  if (mp?.mounted) mp.pane.refresh();
}

function updateStatus(): void {
  if (!controlRefs) return;
  const gb = state.gb;
  if (!gb) {
    controlRefs.status.textContent = "No ROM";
    // No ROM = all actions meaningless. Disable everything except the
    // status indicator itself.
    controlRefs.playPause.disabled = true;
    controlRefs.stepInstr.disabled = true;
    controlRefs.stepFrame.disabled = true;
    controlRefs.stepBack.disabled = true;
    controlRefs.playPause.textContent = "▶";
    return;
  }
  controlRefs.status.textContent = `${state.paused ? "Paused" : "Running"} • Frame ${state.frameCount.toLocaleString()}`;
  controlRefs.playPause.disabled = false;
  controlRefs.playPause.textContent = state.paused ? "▶" : "❚❚";
  controlRefs.playPause.title = state.paused ? "Play (Space)" : "Pause (Space)";
  // Step / Step-frame / Step-back auto-pause before running, so
  // technically they're meaningful while the game is playing too. But
  // the common workflow is "pause, then step" — showing them as
  // disabled-while-running communicates that pause is the gateway
  // without taking the feature away (they still work, we just dim the
  // affordance). Enable them whenever paused OR the first click would
  // auto-pause and perform the step in one gesture.
  controlRefs.stepInstr.disabled = false;
  controlRefs.stepFrame.disabled = false;
  // Step-back is only meaningful when the rewind buffer holds at least
  // one snapshot. Before the first 1 s tick of play passes, `size`
  // stays 0 and the button disables itself so clicks don't toast
  // "No more rewind history" on what should be an obvious affordance.
  const hasRewind = (state.rewinder?.size ?? 0) > 0;
  controlRefs.stepBack.disabled = !hasRewind;
  controlRefs.stepBack.title = hasRewind
    ? "Rewind one snapshot (Backspace is hold-to-rewind)"
    : "No rewind history yet";
}
