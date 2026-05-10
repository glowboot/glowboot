import { NO_LINK } from "../../gb";
import {
  audioResetBtn,
  audioRumbleToggle,
  autoPauseToggle,
  colorCorrectionToggle,
  displayResetBtn,
  gamepadDetectedEl,
  gradeBrightness,
  gradeContrast,
  gradeGamma,
  gradeSaturation,
  gradeTemperature,
  integerScaleToggle,
  libraryExportBtn,
  libraryImportBtn,
  libraryImportInput,
  linkCableModeSelect,
  linkRoomCodeInput,
  linkStatusEl,
  muteButtons,
  paletteNote,
  paletteSelect,
  pixelResponseSlider,
  renderModeSelect,
  rewindCapacitySelect,
  rumblePresetSelect,
  rumbleResetBtn,
  rumbleStrengthSlider,
  sessionResetBtn,
  settingsExportBtn,
  settingsImportBtn,
  settingsImportInput,
  settingsPop,
  settingsSavedPip,
  settingsSearchInput,
  touchHapticToggle,
  touchMirrorToggle,
  touchResetBtn,
  touchRoot,
  touchScaleSlider,
  touchSelect,
  touchSpacingSlider,
  volumeSlider
} from "../dom.js";
import { confirmAction } from "../hud/modal.js";
import { errorToast, toast } from "../hud/toast.js";
import * as Touch from "../input/touch.js";
import {
  applyTouchLayout,
  DEFAULT_TOUCH_LAYOUT,
  loadTouchLayout,
  saveTouchLayout,
  type TouchLayout
} from "../input/touch-layout.js";
import { downloadLibrary, importLibrary } from "../persistence/io/library.js";
import { downloadSettings, importSettings } from "../persistence/io/settings.js";
import { KEYS, lsGet, lsRemove, lsSet } from "../persistence/local-storage.js";
import * as Palettes from "../session/palettes.js";
import {
  audio,
  DEFAULT_RUMBLE_PRESET_ID,
  gamepad,
  renderer,
  RUMBLE_PRESETS,
  setRumblePresetId,
  state,
  swapRenderer
} from "../state.js";

/**
 * Everything rendered inside the Settings popover *except* the input
 * binding editors (which live in `bindings.ts`): palette picker, CRT
 * overlay, theme picker, master volume, per-channel mutes, touch
 * settings, rumble, etc. Each section reads its persisted value from
 * localStorage on first load and writes back on user input.
 */

/** Flash the "Saved" pip in the popover's top-right corner for ~1.2 s
 *  whenever any settings control commits a new value. Delegated on the
 *  popover root so we don't have to touch every section's change
 *  handler — `change` bubbles out of inputs / selects / checkboxes. */
let savedFlashTimer = 0;
function flashSaved(): void {
  const el = settingsSavedPip;
  if (!el) return;
  el.classList.add("is-visible");
  clearTimeout(savedFlashTimer);
  savedFlashTimer = window.setTimeout(() => el.classList.remove("is-visible"), 1200);
}
settingsPop?.addEventListener("change", flashSaved);

/** Live-filter the settings popover by label substring. Match scope
 *  is deliberately narrow — the row's own text, semantic aria-labels
 *  of its button-like children (theme swatches), mute-channel titles
 *  ("Pulse 1", "Wave"), plus the row's sub-group heading and section
 *  heading so a search for "gamepad" or "display" catches everything
 *  in that bucket.
 *
 *  `title` attributes are explicitly excluded — they carry verbose
 *  descriptive tooltips ("Turn off to make this tab ignore every
 *  gamepad…") that overlap heavily and would cause false positives
 *  (e.g. "rumble" matching the Gamepad-enabled row's tooltip).
 *
 *  Collapsed sections hide their contents even when rows match, so
 *  we auto-uncollapse every section while a query is active and
 *  restore the user's persisted collapsed state on empty query. */
let preSearchCollapsed: Set<string> | null = null;

function haystackFor(row: HTMLElement): string {
  const parts: string[] = [row.textContent ?? ""];
  for (const el of row.querySelectorAll<HTMLElement>("[aria-label]")) {
    parts.push(el.getAttribute("aria-label") ?? "");
  }
  // Mute-button channel names ("Pulse 1", "Wave") live in title; they
  // carry real search vocabulary (unlike the verbose row titles).
  for (const btn of row.querySelectorAll<HTMLElement>(".mute-btn[title]")) {
    parts.push(btn.getAttribute("title") ?? "");
  }
  const sub = row.closest(".bindings-group")?.querySelector(".bindings-sub");
  if (sub) parts.push(sub.textContent ?? "");
  const h4 = row.closest(".settings-section")?.querySelector("h4");
  if (h4) parts.push(h4.textContent ?? "");
  return parts.join(" ").toLowerCase();
}

function applySettingsFilter(q: string): void {
  const pop = settingsPop;
  if (!pop) return;
  const query = q.trim().toLowerCase();

  // Enter/leave search mode — sync the uncollapse-all behaviour.
  if (query && preSearchCollapsed === null) {
    preSearchCollapsed = new Set();
    for (const sec of pop.querySelectorAll<HTMLElement>(".settings-section.collapsed")) {
      if (sec.dataset.section) preSearchCollapsed.add(sec.dataset.section);
      sec.classList.remove("collapsed");
      sec.querySelector<HTMLElement>("h4")?.setAttribute("aria-expanded", "true");
    }
  } else if (!query && preSearchCollapsed !== null) {
    for (const sec of pop.querySelectorAll<HTMLElement>(".settings-section[data-section]")) {
      const name = sec.dataset.section;
      if (!name || !preSearchCollapsed.has(name)) continue;
      sec.classList.add("collapsed");
      sec.querySelector<HTMLElement>("h4")?.setAttribute("aria-expanded", "false");
    }
    preSearchCollapsed = null;
  }

  const rowSelector = ".settings-row, .binding-row";
  for (const row of pop.querySelectorAll<HTMLElement>(rowSelector)) {
    row.hidden = query ? !haystackFor(row).includes(query) : false;
  }

  // Sub-groups hide when no rows inside matched AND the sub-header
  // itself doesn't carry the query term. The header-match path lets
  // atomic groups (Palette — just a grid, no rows) surface on
  // searches like "palette" or "colour grading".
  for (const group of pop.querySelectorAll<HTMLElement>(".bindings-group")) {
    if (!query) {
      group.hidden = false;
      continue;
    }
    const subText = (group.querySelector(".bindings-sub")?.textContent ?? "").toLowerCase();
    const sectionText = (group.closest(".settings-section")?.querySelector("h4")?.textContent ?? "").toLowerCase();
    const headerMatch = subText.includes(query) || sectionText.includes(query);
    if (headerMatch) {
      group.hidden = false;
      for (const row of group.querySelectorAll<HTMLElement>(rowSelector)) row.hidden = false;
      continue;
    }
    const anyVisibleRow = Array.from(group.querySelectorAll<HTMLElement>(rowSelector)).some((r) => !r.hidden);
    group.hidden = !anyVisibleRow;
  }

  // A section is visible if any row or any sub-group below it is.
  for (const sec of pop.querySelectorAll<HTMLElement>(".settings-section")) {
    if (!query) {
      sec.hidden = false;
      continue;
    }
    const anyRow = Array.from(sec.querySelectorAll<HTMLElement>(rowSelector)).some((r) => !r.hidden);
    const anyGroup = Array.from(sec.querySelectorAll<HTMLElement>(".bindings-group")).some((g) => !g.hidden);
    sec.hidden = !(anyRow || anyGroup);
  }
}
if (settingsSearchInput) {
  const input = settingsSearchInput;
  input.addEventListener("input", () => applySettingsFilter(input.value));
}

/** Auto-injected numeric readout next to every range slider in the
 *  settings popover. Keeps the HTML markup lean — we don't have to
 *  hand-author an `<output>` next to each of the 7+ sliders — and the
 *  formatting is derived from the slider's own `step` / `max`:
 *    - max===100 and step≥1  → percentage ("80%")
 *    - step<1                → two-decimal float ("0.75")
 *    - else                  → raw value
 *  Programmatic value changes (e.g. the grade-reset button snapping
 *  sliders back to defaults) use `syncSliderLabel` below rather than
 *  dispatching a synthetic `input` event, which would retrigger the
 *  slider's own handler and double-write localStorage. */
function formatSliderValue(s: HTMLInputElement): string {
  const v = parseFloat(s.value);
  const max = parseFloat(s.max || "0");
  const step = parseFloat(s.step || "1");
  if (max === 100 && step >= 1) return `${Math.round(v)}%`;
  if (step < 1) return v.toFixed(2);
  return String(v);
}
const sliderLabelUpdaters = new WeakMap<HTMLInputElement, () => void>();

function syncSliderLabel(s: HTMLInputElement | null): void {
  if (s) sliderLabelUpdaters.get(s)?.();
}
// NOTE: the actual output injection + initial label text live at the
// very bottom of this file. Each section below sets its slider's
// `.value = storedValue` from INIT_LS, and programmatic `.value`
// writes don't fire `input` — so reading `.value` here would capture
// the HTML default ("50") instead of the restored user preference
// ("5"). Running the injection pass last lets us read the final
// post-restore value on every slider in one sweep.

/** One-shot snapshot of localStorage at module import. Used by the
 *  module-init readers below so we don't fire ~15 sequential
 *  Storage bridge calls on the startup path. Runtime readers (change
 *  handlers, enableLinkCable) still call `lsGet` directly so they
 *  observe user-updated values. All writes go through `lsSet` — this
 *  snapshot is read-only.
 *
 *  Wrapped in try/catch because iterating storage hits `length` /
 *  `key(i)` which throw on the same private-mode / disabled-storage
 *  paths the rest of the wrapper guards against; an empty snapshot
 *  simply means every reader falls back to its default. */
const INIT_LS: Record<string, string> = (() => {
  const snap: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      const val = localStorage.getItem(key);
      if (val !== null) snap[key] = val;
    }
  } catch (err) {
    console.warn("[Storage] localStorage snapshot failed:", err);
  }
  return snap;
})();

// ─── Section reset infrastructure ────────────────────────────────────────
// Each settings section (Display, Touch, Rumble, Audio, Session) has a
// little reset button next to its `<h4>`. Clicking it should flip every
// control inside that section back to defaults — instantly, no reload.
//
// Rather than centralising all the reset logic here (which would mean
// re-implementing every init block's apply-to-UI step), we use a dispatch
// pattern: the reset button clears the section's localStorage keys and
// fires a `gb-section-reset` CustomEvent. Each setting's existing init
// IIFE listens for the event and, if it matches its section, re-applies
// the (now-cleared, so default) value to its UI control + side effects.
//
// Order of listener invocation is registration order, which here matches
// source order. That doesn't matter functionally because storage is
// cleared *before* the dispatch — every listener reads via `lsGet` and
// gets the default, regardless of when it fires.
//
// Keyboard / hotkeys / gamepad section resets aren't here; their reset
// buttons live next to the same h4 but are wired in `bindings.ts` (the
// existing handlers already do the right thing).
type ResetSection = "display" | "touch" | "rumble" | "audio" | "behavior";
const SECTION_RESET_EVENT = "gb-section-reset";
function onSectionReset(section: ResetSection, fn: () => void): void {
  document.addEventListener(SECTION_RESET_EVENT, (e) => {
    if ((e as CustomEvent<ResetSection>).detail === section) fn();
  });
}
function wireSectionReset(
  btn: HTMLButtonElement | null,
  section: ResetSection,
  keys: readonly string[],
  toastLabel: string
): void {
  btn?.addEventListener("click", (e) => {
    e.stopPropagation(); // h4 owns the collapse handler
    for (const k of keys) lsRemove(k);
    document.dispatchEvent(new CustomEvent<ResetSection>(SECTION_RESET_EVENT, { detail: section }));
    toast(`${toastLabel} settings reset`);
  });
}

// ─── Palette picker ──────────────────────────────────────────────────────
// Lives inline with the other selects at the top of Display. The
// previous 3-column swatch grid was the only such layout in the
// popover; users rarely change palette after the first session, so a
// plain dropdown fits the design pattern without meaningful loss.
let currentPaletteId = Palettes.loadPaletteId();

function buildPaletteSelect(): void {
  const el = paletteSelect;
  if (!el) return;
  el.innerHTML = "";
  for (const p of Palettes.PALETTES) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    el.appendChild(opt);
  }
  el.value = currentPaletteId;
  el.addEventListener("change", () => {
    currentPaletteId = el.value;
    Palettes.savePaletteId(currentPaletteId);
    applyCurrentPalette();
  });
}

function syncPaletteSelection(): void {
  if (paletteSelect) paletteSelect.value = currentPaletteId;
}

export function applyCurrentPalette(): void {
  const p = Palettes.findPalette(currentPaletteId) ?? Palettes.findPalette(Palettes.DEFAULT_PALETTE_ID)!;
  if (state.gb && !state.gb.cart.cgb) state.gb.ppu.setDmgCompatPalette(p.bg, p.obp0, p.obp1);
  syncPaletteSelection();
}

export function refreshPaletteAvailability(): void {
  const isDmg = !!state.gb && !state.gb.cart.cgb;
  // CGB carts ship their own palette in ROM; the DMG picker has no
  // effect, so disable the select and surface the explainer note.
  if (paletteSelect) paletteSelect.disabled = !isDmg;
  if (paletteNote) paletteNote.hidden = isDmg;
}

buildPaletteSelect();
onSectionReset("display", () => {
  currentPaletteId = Palettes.DEFAULT_PALETTE_ID;
  applyCurrentPalette();
});

// ─── CGB colour correction ───────────────────────────────────────────────
// Emulates the real Game Boy Color LCD's warm, muted colour response so CGB
// games look as they did on the original hardware (raw RGB555 output on an
// sRGB monitor is far too neon). Only affects CGB games; DMG carts use the
// hand-curated palette presets. Default ON — the raw output looks
// unnaturally neon on sRGB displays and the correction is the closer
// match to hardware. Users who prefer raw RGB555 can flip it off.
// Stored under `gb-color-correction` (explicit "0" means opted out).
const colorCorrectionEnabled = INIT_LS[KEYS.COLOR_CORRECTION] !== "0";

/** Exposed so `rom-loader` can re-apply the setting whenever a new GameBoy
 *  instance is created (the PPU default is off). */
export function applyColorCorrection(): void {
  if (state.gb) state.gb.ppu.colorCorrection = colorCorrectionEnabledRef.value;
}
const colorCorrectionEnabledRef = { value: colorCorrectionEnabled };
{
  const el = colorCorrectionToggle;
  if (el) {
    el.checked = colorCorrectionEnabled;
    el.addEventListener("change", () => {
      const on = el.checked;
      colorCorrectionEnabledRef.value = on;
      if (state.gb) state.gb.ppu.colorCorrection = on;
      lsSet(KEYS.COLOR_CORRECTION, on ? "1" : "0");
    });
  }
  onSectionReset("display", () => {
    colorCorrectionEnabledRef.value = true;
    if (state.gb) state.gb.ppu.colorCorrection = true;
    if (el) el.checked = true;
  });
}

// ─── Integer scaling ─────────────────────────────────────────────────────
// Sizes the canvas to the largest whole-number multiple of 160×144 that
// fits its container so every on-screen pixel represents the same number
// of source pixels. Without this the browser stretches 160-px source to
// the container width and produces uneven pixel sizes even with
// `image-rendering: pixelated`. Default ON — avoids the subtle uneven-
// pixel shimmer most users notice on first sight. Persists in
// `gb-integer-scale` (explicit "0" means opted out).
{
  const enabled = INIT_LS[KEYS.INTEGER_SCALE] !== "0";
  renderer.integerScale = enabled;
  const el = integerScaleToggle;
  if (el) {
    el.checked = enabled;
    el.addEventListener("change", () => {
      const on = el.checked;
      renderer.integerScale = on;
      lsSet(KEYS.INTEGER_SCALE, on ? "1" : "0");
    });
  }
  onSectionReset("display", () => {
    renderer.integerScale = true;
    if (el) el.checked = true;
  });
}

// ─── Pixel response (temporal blend) ─────────────────────────────────────
// Exponential-decay blend with the previous frame, applied before either
// renderer backend hits its draw call. 0 = off, 0.5 = old 50/50 ghost
// behaviour, up to 0.85 for a pronounced LCD smear. Persists in
// `gb-pixel-response` as a float string.
{
  const stored = parseFloat(INIT_LS[KEYS.PIXEL_RESPONSE] ?? "0");
  const initial = Number.isFinite(stored) ? Math.max(0, Math.min(0.85, stored)) : 0;
  renderer.setPixelResponse(initial);
  const el = pixelResponseSlider;
  if (el) {
    el.value = String(initial);
    el.addEventListener("input", () => {
      const v = parseFloat(el.value) || 0;
      renderer.setPixelResponse(v);
      lsSet(KEYS.PIXEL_RESPONSE, String(v));
    });
  }
  onSectionReset("display", () => {
    renderer.setPixelResponse(0);
    if (el) {
      el.value = "0";
      syncSliderLabel(el);
    }
  });
}

// ─── Rendering mode (Canvas 2D vs WebGL + shader) ────────────────────────
// Stored under `gb-render-mode`. The renderer is picked once at module
// init in state.ts — a canvas's context type is fixed after first use,
// so changing this setting requires a reload. The select just writes the
// pref and nudges the user to reload. Unknown values fall back to canvas.
type RenderMode = "canvas" | "webgl-lcd" | "webgl-sxbr" | "webgl-crt" | "webgl-bilinear" | "webgl-mmpx";
const RENDER_MODES: readonly RenderMode[] = [
  "canvas",
  "webgl-lcd",
  "webgl-sxbr",
  "webgl-crt",
  "webgl-bilinear",
  "webgl-mmpx"
];

/** Default render mode for a fresh browser — MMPX (style-preserving 2×
 *  pixel-art magnification, McGuire & Mara 2020) keeps sprites and fonts
 *  pixel-crisp while rounding diagonals and corners cleanly. Users who
 *  prefer a different shader (or pure Canvas 2D) override via the
 *  dropdown. */
const DEFAULT_RENDER_MODE: RenderMode = "webgl-mmpx";
function normaliseRenderMode(v: unknown): RenderMode {
  return RENDER_MODES.includes(v as RenderMode) ? (v as RenderMode) : DEFAULT_RENDER_MODE;
}
{
  const current = normaliseRenderMode(INIT_LS[KEYS.RENDER_MODE]);
  const el = renderModeSelect;
  const applyMode = (v: RenderMode): void => {
    const next = swapRenderer(v);
    next.integerScale = lsGet(KEYS.INTEGER_SCALE) !== "0";
    const stored = parseFloat(lsGet(KEYS.PIXEL_RESPONSE) ?? "0");
    next.setPixelResponse(Number.isFinite(stored) ? Math.max(0, Math.min(0.85, stored)) : 0);
    next.setColorGrade(loadGrade());
  };
  if (el) {
    el.value = current;
    el.addEventListener("change", () => {
      const v = normaliseRenderMode(el.value);
      lsSet(KEYS.RENDER_MODE, v);
      // Hot-swap: `swapRenderer` replaces the <canvas> element (context
      // types are sticky once a context is created) and rebuilds the
      // renderer. The new instance starts at defaults, so we re-apply
      // every renderer-owned pref before the next frame.
      applyMode(v);
    });
  }
  onSectionReset("display", () => {
    if (el) el.value = DEFAULT_RENDER_MODE;
    applyMode(DEFAULT_RENDER_MODE);
  });
}

// ─── Colour grading (WebGL only) ─────────────────────────────────────────
// Five uniform-backed sliders (brightness / contrast / gamma / saturation
// / temperature) that compose on top of whichever WebGL shader is active.
// No-op on Canvas 2D — the host's `setColorGrade` implementation there
// is a stub. Persisted as a single JSON blob under `gb-grade` so the
// whole tuning moves together on export / import.
import type { ColorGrade } from "../renderer";
const DEFAULT_GRADE: ColorGrade = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  saturation: 1,
  temperature: 0
};
function loadGrade(): ColorGrade {
  const raw = lsGet(KEYS.COLOR_GRADE);
  if (!raw) return { ...DEFAULT_GRADE };
  try {
    const parsed = JSON.parse(raw) as Partial<ColorGrade>;
    return { ...DEFAULT_GRADE, ...parsed };
  } catch {
    return { ...DEFAULT_GRADE };
  }
}
{
  const grade = loadGrade();
  renderer.setColorGrade(grade);

  const rows: Array<[HTMLInputElement | null, keyof ColorGrade]> = [
    [gradeBrightness, "brightness"],
    [gradeContrast, "contrast"],
    [gradeGamma, "gamma"],
    [gradeSaturation, "saturation"],
    [gradeTemperature, "temperature"]
  ];

  for (const [el, key] of rows) {
    if (!el) continue;
    el.value = String(grade[key]);
    el.addEventListener("input", () => {
      grade[key] = parseFloat(el.value);
      renderer.setColorGrade(grade);
      lsSet(KEYS.COLOR_GRADE, JSON.stringify(grade));
    });
  }

  const resetGradeUi = (): void => {
    Object.assign(grade, DEFAULT_GRADE);
    for (const [el, key] of rows) {
      if (!el) continue;
      el.value = String(grade[key]);
      // Programmatic .value change doesn't fire `input`, so sync the
      // companion readout explicitly here (alternative: dispatch a
      // synthetic input event, but that re-fires the slider's own
      // handler and double-writes the whole grade to localStorage).
      syncSliderLabel(el);
    }
    renderer.setColorGrade(grade);
  };

  // Section-level Display reset: storage is already cleared by the
  // dispatcher, so just push the default grade back into the UI +
  // renderer.
  onSectionReset("display", resetGradeUi);
}

// ─── Auto-pause on focus loss ────────────────────────────────────────────
// User-facing setting for the window.blur / window.focus handlers in
// auto-pause.ts. The listeners themselves read `gb-auto-pause` directly
// so this block only needs to manage the checkbox state. Defaults to ON
// — most desktop emulators behave this way and it prevents games from
// running silently in the background. Persists in `gb-auto-pause`.
{
  const enabled = INIT_LS[KEYS.AUTO_PAUSE] !== "0";
  const el = autoPauseToggle;
  if (el) {
    el.checked = enabled;
    el.addEventListener("change", () => {
      lsSet(KEYS.AUTO_PAUSE, el.checked ? "1" : "0");
    });
  }
  onSectionReset("behavior", () => {
    if (el) el.checked = true;
  });
}

// ─── Rewind-buffer length ────────────────────────────────────────────────
// One snapshot per second, so `capacity` == seconds of history. Memory
// footprint is linear (~80 KB per second). We apply the choice live to
// the current RewindBuffer (if any) via `setCapacity`, and rom-loader
// reads the pref when constructing a fresh buffer on ROM load. 60 s is
// the historical default. Persists in `gb-rewind-capacity`.
{
  const DEFAULT_REWIND_SECONDS = 60;
  const stored = parseInt(INIT_LS[KEYS.REWIND_CAPACITY] ?? String(DEFAULT_REWIND_SECONDS), 10);
  const initial = Number.isFinite(stored) ? stored : DEFAULT_REWIND_SECONDS;
  const el = rewindCapacitySelect;
  if (el) {
    el.value = String(initial);
    // If the stored value isn't one of the preset options, the <select>
    // falls through to the first option — snap the persisted value to
    // what the user actually sees so there's no silent mismatch.
    if (el.value !== String(initial)) el.value = String(DEFAULT_REWIND_SECONDS);
    el.addEventListener("change", () => {
      const seconds = parseInt(el.value, 10) || DEFAULT_REWIND_SECONDS;
      state.rewinder?.setCapacity(seconds);
      lsSet(KEYS.REWIND_CAPACITY, String(seconds));
    });
  }
  onSectionReset("behavior", () => {
    state.rewinder?.setCapacity(DEFAULT_REWIND_SECONDS);
    if (el) el.value = String(DEFAULT_REWIND_SECONDS);
  });
}

// ─── Link cable ──────────────────────────────────────────────────────────
// Three modes share one select:
//   - off:    NO_LINK, the default no-cable behaviour.
//   - 2p:     pair with another tab/device. Empty room code = local
//             BroadcastChannel; set a room code to pair across devices
//             via the build-time relay URL (`VITE_LINK_RELAY_URL`).
//   - printer: virtual Game Boy Printer plugged into the serial port.
//             Captured pages land in the printer popover.
// Persists in `gb-link-cable` (mode string), `gb-link-room-code`.
type LinkMode = "off" | "2p" | "printer";

/** Build-time URL of the Cloudflare Worker relay. Baked in via Vite at
 *  build time so users don't have to know the URL exists; left empty
 *  when unset, which gracefully falls back to BroadcastChannel-only
 *  same-machine pairing. */
const RELAY_URL = ((import.meta.env.VITE_LINK_RELAY_URL as string | undefined) ?? "").trim();

function readLinkMode(): LinkMode {
  const v = INIT_LS[KEYS.LINK_CABLE_MODE];
  // Migrate the pre-printer "1"/"0" boolean encoding to the new mode string.
  if (v === "1") return "2p";
  if (v === "2p" || v === "printer") return v;
  return "off";
}

{
  const initialMode = readLinkMode();
  const select = linkCableModeSelect;
  const roomEl = linkRoomCodeInput;

  if (roomEl) roomEl.value = INIT_LS[KEYS.LINK_ROOM_CODE] ?? "";

  // Status pill: listens on the document-level CustomEvent fired by
  // the 2-player link implementations when pairing state changes. The
  // printer link is always "connected" the moment it's enabled, so we
  // set the pill directly when switching to / from printer mode.
  const LABELS: Record<string, string> = {
    off: "Off",
    idle: "Waiting",
    connected: "Connected",
    error: "Error"
  };
  function setLinkStatus(status: string): void {
    if (!linkStatusEl) return;
    linkStatusEl.dataset.status = status;
    linkStatusEl.textContent = LABELS[status] ?? status;
  }
  document.addEventListener("gb-link-status", (e) => {
    const status = (e as CustomEvent<string>).detail;
    setLinkStatus(status);
  });
  // Hide the Room code row except in 2-player mode where it actually
  // matters. Hide the printer popover trigger except in printer mode.
  const subRows = document.querySelectorAll<HTMLElement>(".settings-row.link-cable-sub");
  function syncMode(mode: LinkMode): void {
    for (const row of subRows) row.hidden = mode !== "2p";
    // Printer button is always present in the action row now; the
    // printer module owns the disabled-flag logic so it can keep the
    // trigger enabled when there's persisted print history even if
    // the link cable isn't currently set to "printer".
    void import("../popovers/printer.js").then((m) => m.setLinkModeIsPrinter(mode === "printer"));
  }

  if (select) {
    select.value = initialMode;
    syncMode(initialMode);
    if (initialMode === "2p") void enable2PlayerLink();
    else if (initialMode === "printer") void enablePrinterLink();
    else setLinkStatus("off");
    select.addEventListener("change", () => {
      const mode = select.value as LinkMode;
      // Tear down whatever's currently active before bringing the new
      // mode online. Both the 2-player link and the printer share the
      // same `state.link` slot.
      disableLink();
      syncMode(mode);
      if (mode === "2p") void enable2PlayerLink();
      else if (mode === "printer") void enablePrinterLink();
      else setLinkStatus("off");
      lsSet(KEYS.LINK_CABLE_MODE, mode);
    });
  }
  // Changing the room code while 2-player is already connected: tear
  // down and reopen so the new code takes effect without needing a
  // page reload.
  const onLinkParamChange = async (): Promise<void> => {
    if (roomEl) {
      lsSet(KEYS.LINK_ROOM_CODE, roomEl.value.trim());
    }
    if (select?.value === "2p") {
      disableLink();
      await enable2PlayerLink();
    }
  };
  roomEl?.addEventListener("change", () => void onLinkParamChange());

  // Expose the helper to enable/disable callers below without dragging
  // the closure across a top-level boundary.
  (globalThis as unknown as { __gbSetLinkStatus?: (s: string) => void }).__gbSetLinkStatus = setLinkStatus;

  onSectionReset("behavior", () => {
    // Tear down any active link before flipping the UI back to defaults
    // — mid-session pairings shouldn't survive a reset.
    disableLink();
    syncMode("off");
    setLinkStatus("off");
    if (select) select.value = "off";
    if (roomEl) roomEl.value = "";
  });
}

async function enable2PlayerLink(): Promise<void> {
  if (state.link) return;
  const roomCode = (lsGet(KEYS.LINK_ROOM_CODE) ?? "").trim();
  if (roomCode && RELAY_URL) {
    // Remote pairing via the build-time relay URL — WebRTC P2P with
    // WebSocket-relay fallback when the DataChannel can't establish.
    console.info(`[Link] 2P mode → cross-device via ${RELAY_URL}`);
    const { WebRTCLink } = await import("../session/webrtc-link.js");
    state.link = new WebRTCLink(roomCode, RELAY_URL);
  } else {
    // No room code (or no relay URL configured at build time) → fall
    // back to BroadcastChannel for same-origin tab pairing. Loud console
    // signal when a room code is set but the build had no URL baked in,
    // since that's almost always a deployment misconfig (env var not
    // set in Cloudflare Pages, or build wasn't redeployed after).
    if (roomCode && !RELAY_URL) {
      console.warn(
        "[Link] 2P mode requested with a room code, but VITE_LINK_RELAY_URL " +
          "is empty in this build. Falling back to same-machine pairing only. " +
          "Set the env var in your hosting provider and redeploy."
      );
    } else {
      console.info("[Link] 2P mode → same-machine (BroadcastChannel)");
    }
    const { BroadcastChannelLink } = await import("../session/link-cable.js");
    state.link = new BroadcastChannelLink();
  }
  if (state.gb) state.gb.mmu.setSerialLink(state.link);
}

async function enablePrinterLink(): Promise<void> {
  if (state.link) return;
  const { PrinterLink } = await import("../session/printer-link.js");
  const { onPagePrinted } = await import("../popovers/printer.js");
  state.link = new PrinterLink(onPagePrinted);
  if (state.gb) state.gb.mmu.setSerialLink(state.link);
  // Printer mode has no peer to wait for — the virtual printer is
  // always plugged in once selected, so jump straight to "Connected".
  const setStatus = (globalThis as unknown as { __gbSetLinkStatus?: (s: string) => void }).__gbSetLinkStatus;
  setStatus?.("connected");
}

function disableLink(): void {
  if (!state.link) return;
  state.link.close();
  state.link = null;
  if (state.gb) {
    // Restore the no-op default so transfers resume failing silently.
    state.gb.mmu.setSerialLink(NO_LINK);
  }
}

// ─── Gamepad connection pill ────────────────────────────────────────────
// Sits inline with the section's <h4>, mirroring the link-cable status
// pill. Browsers only expose `navigator.getGamepads()` after the user
// presses a button on the pad (the "gamepad gesture" requirement), so
// the initial state reads "Press any button" even when one is plugged
// in. The connected/disconnected events flip it to the pad name as
// soon as the pad wakes up.
{
  const el = gamepadDetectedEl;
  if (el) {
    const readConnected = (): string[] => {
      if (typeof navigator.getGamepads !== "function") return [];
      return navigator
        .getGamepads()
        .filter((p): p is Gamepad => p !== null)
        .map((p) => (p.id || `Gamepad #${p.index}`).trim());
    };
    const render = (): void => {
      const pads = readConnected();
      if (pads.length === 0) {
        el.dataset.status = "idle";
        el.textContent = "Press any button";
        el.title = "Press a button on your gamepad to wake it up — browsers don't expose the pad until then.";
        return;
      }
      el.dataset.status = "connected";
      el.textContent = pads.length === 1 ? "Connected" : `${pads.length} pads`;
      el.title = `Detected: ${pads.join(", ")}`;
    };
    render();
    window.addEventListener("gamepadconnected", render);
    window.addEventListener("gamepaddisconnected", render);
  }
}

// ─── Audio-reactive rumble toggle ───────────────────────────────────────
// MBC5 cart rumble (Pokémon Pinball, Perfect Dark, …) is always wired up
// — the cart's own rumble bit drives the motor unconditionally. The
// audio-reactive follower is opt-in (default OFF) because the effect is
// subjective and feels noisy in music-heavy games. The strength slider
// below acts as a soft "off" for users who want to dial it down without
// flipping a separate toggle. Pref: `gb-audio-rumble`.
{
  const audioEnabled = INIT_LS[KEYS.AUDIO_RUMBLE] === "1";
  gamepad.setAudioRumbleEnabled(audioEnabled);

  const audioEl = audioRumbleToggle;

  if (audioEl) {
    audioEl.checked = audioEnabled;
    audioEl.addEventListener("change", () => {
      gamepad.setAudioRumbleEnabled(audioEl.checked);
      lsSet(KEYS.AUDIO_RUMBLE, audioEl.checked ? "1" : "0");
    });
  }

  onSectionReset("rumble", () => {
    gamepad.setAudioRumbleEnabled(false);
    if (audioEl) audioEl.checked = false;
  });
}

// ─── Audio-rumble: preset + strength ────────────────────────────────────
// Preset picks a named mix of the four APU channel envelopes (see
// `RUMBLE_PRESETS` in state.ts). Strength is a 0-100 slider that
// scales the post-mix magnitude — default 50 is a soft pulse. Changes
// apply live through `setRumblePresetId` / `setAudioRumbleStrength`.
// Prefs: `gb-rumble-preset`, `gb-rumble-strength`.
{
  const validIds = new Set(RUMBLE_PRESETS.map((p) => p.id));
  const storedPreset = INIT_LS[KEYS.RUMBLE_PRESET] ?? DEFAULT_RUMBLE_PRESET_ID;
  const presetId = validIds.has(storedPreset) ? storedPreset : DEFAULT_RUMBLE_PRESET_ID;
  setRumblePresetId(presetId);
  const presetEl = rumblePresetSelect;
  if (presetEl) {
    presetEl.innerHTML = "";
    for (const p of RUMBLE_PRESETS) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      presetEl.appendChild(opt);
    }
    presetEl.value = presetId;
    presetEl.addEventListener("change", () => {
      if (!validIds.has(presetEl.value)) return;
      setRumblePresetId(presetEl.value);
      lsSet(KEYS.RUMBLE_PRESET, presetEl.value);
    });
  }

  // Linear mapping. The gamepad layer interprets this as a sensitivity
  // knob (lower → higher activation threshold → fewer pulses), not as
  // a magnitude multiplier, so a linear slider produces a smooth
  // perceptual ramp on every platform — no curve compensation needed.
  const strengthGain = (pct: number): number => pct / 100;

  const DEFAULT_STRENGTH_PCT = 50;
  const storedStrength = parseInt(INIT_LS[KEYS.RUMBLE_STRENGTH] ?? String(DEFAULT_STRENGTH_PCT), 10);
  const strengthPct = Number.isFinite(storedStrength)
    ? Math.max(0, Math.min(100, storedStrength))
    : DEFAULT_STRENGTH_PCT;
  gamepad.setAudioRumbleStrength(strengthGain(strengthPct));
  const strEl = rumbleStrengthSlider;
  if (strEl) {
    strEl.value = String(strengthPct);
    strEl.addEventListener("input", () => {
      const pct = parseInt(strEl.value, 10) || 0;
      gamepad.setAudioRumbleStrength(strengthGain(pct));
      lsSet(KEYS.RUMBLE_STRENGTH, String(pct));
    });
  }

  onSectionReset("rumble", () => {
    setRumblePresetId(DEFAULT_RUMBLE_PRESET_ID);
    if (presetEl) presetEl.value = DEFAULT_RUMBLE_PRESET_ID;
    gamepad.setAudioRumbleStrength(strengthGain(DEFAULT_STRENGTH_PCT));
    if (strEl) {
      strEl.value = String(DEFAULT_STRENGTH_PCT);
      syncSliderLabel(strEl);
    }
  });
}

// ─── Theme picker ────────────────────────────────────────────────────────
// The initial theme is applied by an inline script in index.html (so the
// background doesn't flash before the module graph boots). Here we just
// sync the button "active" state and react to user clicks.
const themeOpts = Array.from(document.querySelectorAll<HTMLButtonElement>(".theme-opt"));
const KNOWN_THEMES = new Set(themeOpts.map((b) => b.dataset.t ?? "").filter(Boolean));
const DEFAULT_THEME = "aurora-band";
// The bootstrap script in index.html sets data-theme from localStorage
// without validating the value. If a user upgraded across a version
// that retired a theme (e.g. starfield, cherry-blossom), they'd land
// on an unstyled body. Fall back to the default here and persist.
if (!KNOWN_THEMES.has(document.body.dataset.theme ?? "")) {
  document.body.dataset.theme = DEFAULT_THEME;
  lsSet(KEYS.THEME, DEFAULT_THEME);
}
function syncThemeOpts(): void {
  const current = document.body.dataset.theme;
  for (const b of themeOpts) b.classList.toggle("active", b.dataset.t === current);
}
syncThemeOpts();
for (const b of themeOpts) {
  b.addEventListener("click", () => {
    const t = b.dataset.t;
    if (!t) return;
    document.body.dataset.theme = t;
    lsSet(KEYS.THEME, t);
    syncThemeOpts();
  });
}
onSectionReset("display", () => {
  document.body.dataset.theme = DEFAULT_THEME;
  syncThemeOpts();
});

// ─── Master volume ───────────────────────────────────────────────────────
const DEFAULT_VOLUME_PCT = 80;
const savedVolumePct = Math.max(
  0,
  Math.min(100, parseInt(INIT_LS[KEYS.VOLUME] ?? String(DEFAULT_VOLUME_PCT), 10) || DEFAULT_VOLUME_PCT)
);
audio.volume = savedVolumePct / 100;
{
  const el = volumeSlider;
  if (el) {
    el.value = String(savedVolumePct);
    el.addEventListener("input", () => {
      const v = parseInt(el.value, 10) || 0;
      audio.volume = v / 100;
      lsSet(KEYS.VOLUME, String(v));
    });
  }
  onSectionReset("audio", () => {
    audio.volume = DEFAULT_VOLUME_PCT / 100;
    if (el) {
      el.value = String(DEFAULT_VOLUME_PCT);
      syncSliderLabel(el);
    }
  });
}

// ─── Per-channel mutes ───────────────────────────────────────────────────
const savedMutes = (INIT_LS[KEYS.CHANNEL_MUTES] ?? "0000").padEnd(4, "0");
const muteState: [boolean, boolean, boolean, boolean] = [
  savedMutes.charAt(0) === "1",
  savedMutes.charAt(1) === "1",
  savedMutes.charAt(2) === "1",
  savedMutes.charAt(3) === "1"
];

export function applyMuteState(): void {
  if (state.gb) for (let i = 0; i < 4; i++) state.gb.apu.muteChannel[i] = !!muteState[i];
  muteButtons.forEach((btn) => {
    const ch = parseInt(btn.dataset.ch ?? "0", 10);
    btn.classList.toggle("muted", !!muteState[ch]);
  });
}
applyMuteState();
muteButtons.forEach((btn) =>
  btn.addEventListener("click", () => {
    const ch = parseInt(btn.dataset.ch ?? "0", 10);
    if (ch < 0 || ch > 3) return;
    muteState[ch] = !muteState[ch];
    applyMuteState();
    lsSet(KEYS.CHANNEL_MUTES, muteState.map((m) => (m ? "1" : "0")).join(""));
  })
);
onSectionReset("audio", () => {
  for (let i = 0; i < 4; i++) muteState[i] = false;
  applyMuteState();
});

// ─── Touch controls ──────────────────────────────────────────────────────
const touch = touchRoot ? Touch.initTouchControls(() => state.gb?.joypad ?? null, touchRoot) : null;
const savedTouchMode = Touch.loadTouchMode();
touch?.setMode(savedTouchMode);

/** Mirror the gamepad section's "hide details when input is off"
 *  pattern: when the user picks "Never" for on-screen controls, the
 *  layout knobs below are no use, so collapse them out of the section.
 *  The select stays visible always so the user can flip it back on. */
const touchLayoutGroup = document.querySelector<HTMLElement>(".touch-layout-group");
function syncTouchLayoutVisibility(mode: Touch.TouchMode): void {
  if (!touchLayoutGroup) return;
  touchLayoutGroup.hidden = mode === "off";
}
syncTouchLayoutVisibility(savedTouchMode);
{
  const el = touchSelect;
  if (el) {
    el.value = savedTouchMode;
    el.addEventListener("change", () => {
      const m = el.value as Touch.TouchMode;
      Touch.saveTouchMode(m);
      touch?.setMode(m);
      syncTouchLayoutVisibility(m);
    });
  }
  onSectionReset("touch", () => {
    const def: Touch.TouchMode = "auto";
    if (el) el.value = def;
    touch?.setMode(def);
    syncTouchLayoutVisibility(def);
  });
}

// ─── Touch press haptic ──────────────────────────────────────────────────
// Short device vibration on every fresh GB-button press from the on-
// screen overlay. Independent of the Rumble-section settings, which
// gate cart / audio-driven vibration. Default ON; touch.ts reads the
// stored value on each press, so toggling here takes effect without a
// reload. iOS Safari ignores `navigator.vibrate` regardless, so the
// toggle is functionally an Android haptic gate.
{
  const enabled = INIT_LS[KEYS.TOUCH_PRESS_HAPTIC] !== "0";
  const el = touchHapticToggle;
  if (el) {
    el.checked = enabled;
    el.addEventListener("change", () => {
      lsSet(KEYS.TOUCH_PRESS_HAPTIC, el.checked ? "1" : "0");
    });
  }
  onSectionReset("touch", () => {
    if (el) el.checked = true;
  });
}

// ─── Touch layout (mirror / size / spacing) ──────────────────────────────
{
  let layout = loadTouchLayout();
  applyTouchLayout(layout);

  const persist = (next: Partial<TouchLayout>): void => {
    layout = { ...layout, ...next };
    saveTouchLayout(layout);
    applyTouchLayout(layout);
  };

  // Local non-null aliases inside each block — TS narrows the
  // module-scope refs back to nullable across closure boundaries.
  if (touchMirrorToggle) {
    const el = touchMirrorToggle;
    el.checked = layout.mirror;
    el.addEventListener("change", () => persist({ mirror: el.checked }));
  }
  if (touchScaleSlider) {
    const el = touchScaleSlider;
    el.value = String(layout.scale);
    el.addEventListener("input", () => persist({ scale: Number(el.value) }));
  }
  if (touchSpacingSlider) {
    const el = touchSpacingSlider;
    el.value = String(layout.spacing);
    el.addEventListener("input", () => persist({ spacing: Number(el.value) }));
  }
  const resetTouchLayoutUi = (): void => {
    layout = { ...DEFAULT_TOUCH_LAYOUT };
    applyTouchLayout(layout);
    if (touchMirrorToggle) touchMirrorToggle.checked = layout.mirror;
    if (touchScaleSlider) {
      touchScaleSlider.value = String(layout.scale);
      syncSliderLabel(touchScaleSlider);
    }
    if (touchSpacingSlider) {
      touchSpacingSlider.value = String(layout.spacing);
      syncSliderLabel(touchSpacingSlider);
    }
  };

  // Section-level Touch reset: storage is already cleared by the
  // dispatcher (TOUCH_LAYOUT key gone), so just push defaults to UI +
  // overlay. No persist needed — fresh storage already gives defaults.
  onSectionReset("touch", resetTouchLayoutUi);
}

// ─── Section-level reset button wire-up ──────────────────────────────────
// Each button clears its section's localStorage keys and dispatches the
// `gb-section-reset` event so every settings init block above can revert
// its own UI control + side effect. Keyboard / hotkeys / gamepad section
// resets are wired in `bindings.ts` (the pre-existing handlers — relocated
// in HTML but their logic was already correct).
wireSectionReset(
  displayResetBtn,
  "display",
  [
    KEYS.THEME,
    KEYS.RENDER_MODE,
    KEYS.PALETTE,
    KEYS.COLOR_CORRECTION,
    KEYS.INTEGER_SCALE,
    KEYS.PIXEL_RESPONSE,
    KEYS.COLOR_GRADE
  ],
  "Display"
);
wireSectionReset(touchResetBtn, "touch", [KEYS.TOUCH_MODE, KEYS.TOUCH_PRESS_HAPTIC, KEYS.TOUCH_LAYOUT], "Touch");
wireSectionReset(rumbleResetBtn, "rumble", [KEYS.AUDIO_RUMBLE, KEYS.RUMBLE_PRESET, KEYS.RUMBLE_STRENGTH], "Rumble");
wireSectionReset(audioResetBtn, "audio", [KEYS.VOLUME, KEYS.CHANNEL_MUTES], "Audio");
wireSectionReset(
  sessionResetBtn,
  "behavior",
  [KEYS.AUTO_PAUSE, KEYS.REWIND_CAPACITY, KEYS.LINK_CABLE_MODE, KEYS.LINK_ROOM_CODE],
  "Session"
);

// ─── Settings export / import ────────────────────────────────────────────
// Preferences-only (theme / controls / palette / display toggles / bindings).
// Game progress (save RAM, states, cheats, library) lives in IndexedDB and
// is out of scope for this bundle — it needs its own larger backup flow.
settingsExportBtn?.addEventListener("click", async () => {
  try {
    await downloadSettings();
    toast("Settings exported");
  } catch (err) {
    console.warn("[Settings] export failed:", err);
    errorToast("Export failed");
  }
});

{
  const el = settingsImportInput;
  settingsImportBtn?.addEventListener("click", () => el?.click());
  el?.addEventListener("change", async () => {
    const file = el.files?.[0];
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      errorToast("Could not read file");
      return;
    }
    el.value = "";
    // Confirm before the reload so a running play session isn't torn
    // out from under the user. We haven't touched localStorage yet —
    // cancelling here leaves the current settings untouched.
    const ok = await confirmAction({
      title: "Import settings?",
      body: "Your preferences will be replaced and the page will reload.",
      confirmLabel: "Import and reload"
    });
    if (!ok) return;
    if (!importSettings(text)) {
      errorToast("Invalid settings file");
      return;
    }
    toast("Settings imported — reloading…");
    // Reload so every init path picks up the new localStorage values in
    // the same order it would on a fresh start.
    setTimeout(() => location.reload(), 600);
  });
}

// ─── Library backup / restore ────────────────────────────────────────────
// Dumps / restores every per-cart IndexedDB row (ROM bytes, save RAM, save
// states, cheats, printer history). Export is async — it reads all stores
// and serialises binary fields as base64 — so we show a "preparing" toast
// first. Import upserts: existing rows with the same id are overwritten,
// rows not in the file are left alone; on completion we reload so running
// engine state doesn't hold stale references.
libraryExportBtn?.addEventListener("click", async () => {
  toast("Preparing library backup…");
  try {
    await downloadLibrary();
    toast("Library exported");
  } catch (err) {
    console.warn("[Library] export failed:", err);
    errorToast("Export failed");
  }
});

{
  const el = libraryImportInput;
  libraryImportBtn?.addEventListener("click", () => el?.click());
  el?.addEventListener("change", async () => {
    const file = el.files?.[0];
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      errorToast("Could not read file");
      return;
    }
    el.value = "";
    // Confirm before the reload so a running play session isn't torn
    // out from under the user. Imports are upserts (existing rows
    // with the same cart id are overwritten, rows not in the file are
    // untouched) but the page still reloads so the engine drops any
    // stale references to the replaced data.
    const ok = await confirmAction({
      title: "Import library?",
      body: "Matching carts will be overwritten with the backup's contents, then the page will reload.",
      confirmLabel: "Import and reload"
    });
    if (!ok) return;
    toast("Importing library…");
    const result = await importLibrary(text);
    if (!result.ok) {
      errorToast(result.reason ?? "Import failed");
      return;
    }
    const c = result.counts!;
    const total = c.roms + c.saveRam + c.saveStates + c.cheats + c.printouts;
    toast(`Imported ${total} records — reloading…`);
    setTimeout(() => location.reload(), 800);
  });
}

// ─── Slider value labels (runs last) ───────────────────────────────────
// Auto-injects a live-updating `<output>` next to every range slider
// inside the settings popover. See the top-of-file note — this pass
// runs after every section has restored its slider's `.value` from
// INIT_LS so the initial label reads the stored value, not the HTML
// default.
{
  const sliders = settingsPop?.querySelectorAll<HTMLInputElement>('input[type="range"]');
  if (sliders) {
    for (const s of sliders) {
      const out = document.createElement("output");
      out.className = "settings-slider-value";
      const update = (): void => {
        out.textContent = formatSliderValue(s);
      };
      update();
      s.insertAdjacentElement("afterend", out);
      s.addEventListener("input", update);
      sliderLabelUpdaters.set(s, update);
    }
  }
}
