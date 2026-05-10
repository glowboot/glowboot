import { cartInfoPop, cartInfoTrigger } from "../dom.js";
import { formatPlayTime } from "../format.js";
import { type CartOverrides, loadCartOverrides, saveCartOverrides } from "../persistence/cart-overrides.js";
import { KEYS, lsGet } from "../persistence/local-storage.js";
import * as Recents from "../persistence/recents.js";
import { applyCartOverrides } from "../session/cart-overrides.js";
import * as Palettes from "../session/palettes.js";
import { flushPlayTime, startPlayTimer } from "../session/play-time.js";
import { state } from "../state.js";
import { createPopover } from "./helper.js";

/**
 * Cartridge-info popover — read-only view of the ROM's header metadata
 * (MBC type, ROM/RAM bank counts, battery/RTC flags, CGB mode, region,
 * licensee, header + global checksums) plus cumulative play time. The
 * trigger sits next to the NOW-PLAYING title and is only unhidden once
 * a ROM is loaded (see `rom-loader.ts`).
 */

export const { open: openCartInfo, close: closeCartInfo } = createPopover({
  trigger: cartInfoTrigger,
  pop: cartInfoPop,
  render: renderCartInfo
});

// Clicking the ROM title forwards to the cart-info trigger — same
// popover, wider click target. The trigger is `hidden` until a ROM
// loads; while hidden we no-op so clicking "—" (the placeholder)
// doesn't pop an empty "Load a ROM to see cart info" dialog.
document.getElementById("np-title")?.addEventListener("click", (e) => {
  if (!cartInfoTrigger || cartInfoTrigger.hidden) return;
  e.stopPropagation();
  cartInfoTrigger.click();
});

async function renderCartInfo(): Promise<void> {
  if (!cartInfoPop) return;
  cartInfoPop.innerHTML = "";
  const gb = state.gb;
  if (!gb) {
    const empty = document.createElement("div");
    empty.className = "pop-empty";
    empty.textContent = "Load a ROM to see cart info";
    cartInfoPop.appendChild(empty);
    return;
  }
  const c = gb.cart;
  // Flush the in-memory play-time counter so the value we show reflects
  // the current session, not just the last 30 s-interval checkpoint.
  await flushPlayTime();
  startPlayTimer();
  const recent = (await Recents.list()).find((r) => r.id === Recents.idFor(c));
  const playMs = recent?.totalPlayMs ?? 0;
  const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, "0").toUpperCase()}`;
  const hex4 = (n: number): string => `0x${n.toString(16).padStart(4, "0").toUpperCase()}`;
  const kib = (banks: number, size: number): string =>
    banks === 0 ? "—" : `${banks} × ${size} = ${(banks * size).toLocaleString()} KiB`;

  const title = document.createElement("div");
  title.className = "cart-info-title";
  title.textContent = c.title || "(untitled)";
  cartInfoPop.appendChild(title);

  const mode = c.cgbFlag === 0xc0 ? "CGB-only" : c.cgb ? "CGB-enhanced" : "DMG";
  const region = c.destinationCode === 0x00 ? "Japan" : "Overseas";
  const licensee = c.newLicensee !== null ? `"${c.newLicensee}" (0x33)` : hex2(c.licenseeCode);

  const rows: Array<[string, string]> = [
    ["MBC", `${c.mbcType} (${hex2(c.typeCode)})`],
    ["ROM", kib(c.romBanks, 16)],
    ["RAM", kib(c.ramBanks, 8)],
    ["Battery", c.hasBattery ? "Yes" : "No"],
    ...(c.mbcType === "MBC3" ? [["RTC", c.hasRtc ? "Yes" : "No"] as [string, string]] : []),
    ["Mode", mode],
    ["Region", region],
    ["Licensee", licensee],
    ["Header CRC", hex2(c.headerChecksum)],
    ["Global CRC", hex4(c.globalChecksum)],
    ["ROM size", `${c.rom.length.toLocaleString()} bytes`],
    ["Play time", playMs >= 60_000 ? formatPlayTime(playMs) : "—"]
  ];
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "cart-info-row";
    const ks = document.createElement("span");
    ks.textContent = k;
    const vs = document.createElement("b");
    vs.textContent = v;
    row.appendChild(ks);
    row.appendChild(vs);
    cartInfoPop.appendChild(row);
  }

  // ── Per-game overrides ─────────────────────────────────────────────
  // Each override row mirrors its corresponding Settings popover input
  // (select for render mode + palette, checkbox for toggles, slider for
  // pixel response). When no override is pinned, the input reflects the
  // current global value. Changing the input pins the new value; the
  // small ↺ icon that appears alongside a pinned row clears the pin
  // and the input snaps back to the global.
  const overrides = await loadCartOverrides(c);
  const heading = document.createElement("div");
  heading.className = "cart-info-heading";
  const headingLabel = document.createElement("span");
  headingLabel.textContent = "Per-game overrides";
  heading.appendChild(headingLabel);
  // Reset button reuses the ghost-pill style + counter-clockwise-arrow
  // glyph from the settings popover's .bindings-reset / .grade-reset
  // pattern so the "clear overrides" action reads as the same verb.
  // Disabled when nothing is pinned — no-op clicks shouldn't feel live.
  const hasAnyOverride =
    overrides.renderMode !== undefined ||
    overrides.palette !== undefined ||
    overrides.colorCorrection !== undefined ||
    overrides.integerScale !== undefined ||
    overrides.pixelResponse !== undefined;
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "bindings-reset";
  resetBtn.setAttribute("aria-label", "Clear all per-game overrides");
  resetBtn.title = "Clear all per-game overrides";
  resetBtn.disabled = !hasAnyOverride;
  resetBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path></svg>';
  resetBtn.addEventListener("click", () => {
    void persistOverride({});
  });
  heading.appendChild(resetBtn);
  cartInfoPop.appendChild(heading);

  renderSelectOverride({
    label: "Render mode",
    options: RENDER_MODE_OPTIONS,
    globalValue: lsGet(KEYS.RENDER_MODE) ?? "webgl-mmpx",
    pinned: overrides.renderMode,
    onPin: (v) => persistOverride({ ...overrides, renderMode: v }),
    onReset: () => persistOverride({ ...overrides, renderMode: undefined })
  });

  if (!c.cgb) {
    renderSelectOverride({
      label: "Palette",
      options: Palettes.PALETTES.map((p) => [p.id, p.name]),
      globalValue: Palettes.loadPaletteId(),
      pinned: overrides.palette,
      onPin: (v) => persistOverride({ ...overrides, palette: v }),
      onReset: () => persistOverride({ ...overrides, palette: undefined })
    });
  }

  if (c.cgb) {
    renderCheckboxOverride({
      label: "Colour correction",
      globalValue: lsGet(KEYS.COLOR_CORRECTION) !== "0",
      pinned: overrides.colorCorrection,
      onPin: (v) => persistOverride({ ...overrides, colorCorrection: v }),
      onReset: () => persistOverride({ ...overrides, colorCorrection: undefined })
    });
  }

  renderCheckboxOverride({
    label: "Integer scaling",
    globalValue: lsGet(KEYS.INTEGER_SCALE) !== "0",
    pinned: overrides.integerScale,
    onPin: (v) => persistOverride({ ...overrides, integerScale: v }),
    onReset: () => persistOverride({ ...overrides, integerScale: undefined })
  });

  renderSliderOverride({
    label: "Pixel response",
    min: 0,
    max: 0.85,
    step: 0.01,
    globalValue: clampPixelResponse(parseFloat(lsGet(KEYS.PIXEL_RESPONSE) ?? "0")),
    pinned: overrides.pixelResponse,
    onPin: (v) => persistOverride({ ...overrides, pixelResponse: v }),
    onReset: () => persistOverride({ ...overrides, pixelResponse: undefined })
  });
}

function clampPixelResponse(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(0.85, v)) : 0;
}

/** Mode key → human label. Keep this list in sync with the render-mode
 *  dropdown in `settings/panels.ts`. */
const RENDER_MODE_OPTIONS: Array<[string, string]> = [
  ["webgl-mmpx", "MMPX"],
  ["webgl-sxbr", "Super-xBR"],
  ["webgl-xbr", "xBR"],
  ["webgl-bilinear", "Bilinear"],
  ["webgl-lcd", "LCD"],
  ["webgl-crt", "CRT"],
  ["webgl-dmg", "DMG green"],
  ["canvas", "Canvas 2D"]
];

/** Shared row scaffold — builds `<label class="cart-info-override">`
 *  as a 2-column grid (label / control). Pinned rows get a small
 *  accent bullet before the label and a `title` hint that right-
 *  click clears the override — same pattern as the binding chips
 *  in the Controls editor. Right-click to clear keeps the row
 *  visually uncluttered while still giving users an undo path. */
function buildOverrideRow(label: string, control: HTMLElement, pinned: boolean, onReset: () => void): void {
  if (!cartInfoPop) return;
  const row = document.createElement("label");
  row.className = "cart-info-row cart-info-override";
  if (pinned) row.classList.add("is-pinned");

  const name = document.createElement("span");
  name.textContent = label;
  row.appendChild(name);

  row.appendChild(control);

  if (pinned) {
    control.title = "Right-click to reset to global default";
    control.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onReset();
    });
  }

  cartInfoPop.appendChild(row);
}

interface SelectOverrideOpts {
  label: string;
  options: Array<[string, string]>;
  globalValue: string;
  pinned: string | undefined;
  onPin: (v: string) => void;
  onReset: () => void;
}
function renderSelectOverride(o: SelectOverrideOpts): void {
  const sel = document.createElement("select");
  const effective = o.pinned ?? o.globalValue;
  for (const [value, text] of o.options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    if (value === effective) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => o.onPin(sel.value));
  buildOverrideRow(o.label, sel, o.pinned !== undefined, o.onReset);
}

interface CheckboxOverrideOpts {
  label: string;
  globalValue: boolean;
  pinned: boolean | undefined;
  onPin: (v: boolean) => void;
  onReset: () => void;
}
function renderCheckboxOverride(o: CheckboxOverrideOpts): void {
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = o.pinned ?? o.globalValue;
  cb.addEventListener("change", () => o.onPin(cb.checked));
  // Clicks on the wrapping <label> bubble to the checkbox — stop that
  // short on the input element itself so a user's checkbox flip
  // doesn't also trigger the label-click-toggles-checkbox pathway.
  cb.addEventListener("click", (e) => e.stopPropagation());
  buildOverrideRow(o.label, cb, o.pinned !== undefined, o.onReset);
}

interface SliderOverrideOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  globalValue: number;
  pinned: number | undefined;
  onPin: (v: number) => void;
  onReset: () => void;
}
function renderSliderOverride(o: SliderOverrideOpts): void {
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(o.min);
  slider.max = String(o.max);
  slider.step = String(o.step);
  slider.value = String(o.pinned ?? o.globalValue);
  // Persist on `change` (release) so a mid-drag slider move doesn't
  // thrash IndexedDB — applyCartOverrides triggers a live preview on
  // each call which is meaningful at release, overkill on drag.
  slider.addEventListener("change", () => o.onPin(parseFloat(slider.value)));
  buildOverrideRow(o.label, slider, o.pinned !== undefined, o.onReset);
}

/** Write the new overrides object to IDB and re-apply it to the live
 *  engine. Empty-string values from the dropdown become `undefined`
 *  before reaching here; callers pass the merged object. */
async function persistOverride(next: CartOverrides): Promise<void> {
  const c = state.gb?.cart;
  if (!c) return;
  // Strip empty-string entries that snuck through — the select's "use
  // global" option carries `""`, not the typed-field `undefined` value.
  const clean: CartOverrides = {
    palette: next.palette || undefined,
    colorCorrection: next.colorCorrection,
    renderMode: next.renderMode || undefined,
    integerScale: next.integerScale,
    pixelResponse: next.pixelResponse
  };
  await saveCartOverrides(c, clean);
  applyCartOverrides(clean);
  // Re-render so the reset button's disabled state reflects the new
  // pin-count. Without this, toggling the first override after page
  // load leaves the button stuck on the initial snapshot.
  await renderCartInfo();
}
